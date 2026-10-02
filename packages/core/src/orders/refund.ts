/**
 * Order refund flow.
 *
 *   admin UI / webhook
 *        │
 *        ▼
 *   refundOrder()
 *        │
 *        ├─→ PaymentProvider.refund (idempotency-keyed with refundRequestId)
 *        ├─→ refunds.put (unique-indexed on stripeRefundId)
 *        ├─→ inventory.restore (when lineItemRefunds + restock)
 *        ├─→ order.status / paymentStatus / refundedTotal update
 *        └─→ refund email
 *
 * The function is idempotent with same-key/same-payload semantics:
 * replaying with the same refundRequestId and amount returns the prior result,
 * while conflicting payloads throw an error.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { randomId } from "../util/ids";
import { add, CurrencyMismatchError, type Money } from "../money";
import type { StripeClientOptions } from "../stripe/client";
import type { Order, OrderItem, Refund } from "../types";
import { loadOrder, loadOrderItems, refundsStore } from "./create";
import { derivePaymentStatus, deriveOrderStatusFromRefunds } from "./status";
import { restoreForOrderItem } from "../inventory/restore";
import { sendRefundReceipt } from "./receipt";
import { getPaymentProvider } from "../payment-provider/registry";
import { stripePaymentProvider } from "../payment-provider/stripe-provider";
import type { PaymentProviderCredentials } from "../payment-provider/types";
import { toPaymentProviderRuntimeContext } from "../payment-provider/runtime";

type OrdersStore = StorageCollection<Order>;
function ordersStore(ctx: PluginContext): OrdersStore {
	return (ctx.storage as unknown as { orders: OrdersStore }).orders;
}

export interface LineItemRefund {
	orderItemId: string;
	quantity: number;
	amount: Money;
}

export interface RefundOrderInput {
	orderId: string;
	amount: Money;
	reason?: string;
	lineItemRefunds?: LineItemRefund[];
	restock?: boolean;
	createdByUserId?: string;
	/** Optional provider client credentials (loaded from KV by default). */
	client?: StripeClientOptions;
	/** Stable operation ID for refund idempotency. */
	idempotencyKey: string;
}

async function loadProviderCredentials(
	ctx: PluginContext,
	providerId: string,
	clientOverride?: StripeClientOptions,
): Promise<PaymentProviderCredentials> {
	if (clientOverride?.secretKey) {
		return { secretKey: clientOverride.secretKey };
	}
	if (providerId === "stripe") {
		const secret = (await ctx.kv.get<string>("settings:stripeSecretKey")) ?? "";
		return { secretKey: secret };
	}
	const secret =
		(await ctx.kv.get<string>(`settings:${providerId}SecretKey`)) ??
		(await ctx.kv.get<string>("settings:paymentProviderSecretKey")) ??
		"";
	return { secretKey: secret };
}

export async function refundOrder(
	ctx: PluginContext,
	input: RefundOrderInput,
): Promise<Refund> {
	const order = await loadOrder(ctx, input.orderId);
	if (!order) throw new Error(`Order ${input.orderId} not found`);

	if (order.currency !== input.amount.currency) {
		throw new CurrencyMismatchError(order.currency, input.amount.currency);
	}
	if (input.amount.amount <= 0) {
		throw new Error("Refund amount must be > 0");
	}
	const remaining = order.paidTotal.amount - order.refundedTotal.amount;
	if (input.amount.amount > remaining) {
		throw new Error(
			`Refund ${input.amount.amount} exceeds remaining refundable ${remaining}`,
		);
	}

	// Idempotency check: see if a refund with this refundRequestId/idempotencyKey was already recorded
	// for this order, enforcing same-key/same-payload idempotency.
	const existingRefunds = await refundsStore(ctx).query({
		where: { orderId: order.id },
	});
	const prior = existingRefunds.items.find(
		(r) => (r.data as Refund).refundRequestId === input.idempotencyKey,
	);
	if (prior) {
		const priorRefund = { ...(prior.data as Refund), id: prior.id };
		if (
			priorRefund.amount.amount === input.amount.amount &&
			priorRefund.amount.currency === input.amount.currency
		) {
			return priorRefund; // Replay idempotency: exact match returns prior result
		}
		throw new Error(
			`Conflict: refund with idempotencyKey "${input.idempotencyKey}" already processed with amount ${priorRefund.amount.currency} ${priorRefund.amount.amount}, requested ${input.amount.currency} ${input.amount.amount}`,
		);
	}

	// Route refund call through registered PaymentProvider
	const providerId = (order.providerId ?? (order.metadata?.providerId as string)) ?? "stripe";
	const provider = getPaymentProvider(providerId) ?? stripePaymentProvider;
	const creds = await loadProviderCredentials(ctx, provider.id, input.client);

	const targetPaymentReference = order.paymentReference ?? order.stripePaymentIntentId;
	const refundResult = await provider.refund(
		toPaymentProviderRuntimeContext(ctx),
		{
			paymentReference: targetPaymentReference,
			refundRequestId: input.idempotencyKey,
			amount: input.amount.amount,
			currency: input.amount.currency,
			reason: input.reason,
		},
		creds,
	);

	// Persist refund row (unique-indexed on stripeRefundId).
	const refundId = randomId();
	const refund: Refund = {
		id: refundId,
		orderId: order.id,
		amount: input.amount,
		...(input.reason ? { reason: input.reason } : {}),
		status: refundResult.status,
		stripeRefundId: refundResult.providerRefundId,
		providerId: provider.id,
		refundRequestId: input.idempotencyKey,
		...(input.lineItemRefunds ? { lineItemRefunds: input.lineItemRefunds } : {}),
		restocked: Boolean(input.restock),
		createdAt: new Date().toISOString(),
		...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {}),
	};
	await refundsStore(ctx).put(refundId, refund);

	// Optional restock per line item.
	if (input.restock && input.lineItemRefunds?.length) {
		const items = await loadOrderItems(ctx, order.id);
		const byId = new Map(items.map((it) => [it.id, it]));
		for (const li of input.lineItemRefunds) {
			const orderItem = byId.get(li.orderItemId);
			if (!orderItem) continue;
			if (li.quantity <= 0) continue;
			try {
				await restoreForOrderItem(ctx, {
					orderItem,
					quantity: li.quantity,
					reason: "refund",
				});
			} catch (err) {
				ctx.log.error("Restock failed for orderItem during refund", {
					orderId: order.id,
					orderItemId: li.orderItemId,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	// Update order totals and status.
	const newRefundedTotal = add(order.refundedTotal, input.amount);
	const paymentStatus = derivePaymentStatus(
		order.paidTotal.amount,
		newRefundedTotal.amount,
	);
	const status = deriveOrderStatusFromRefunds(
		order.status,
		order.paidTotal.amount,
		newRefundedTotal.amount,
	);
	const updatedOrder: Order = {
		...order,
		refundedTotal: newRefundedTotal,
		paymentStatus,
		status,
		updatedAt: new Date().toISOString(),
	};
	await ordersStore(ctx).put(order.id, updatedOrder);

	// Email.
	await sendRefundReceipt(ctx, updatedOrder, refund);

	return refund;
}

/**
 * Webhook-driven refund path: we already received the Stripe Refund object
 * from `charge.refunded`. Persist it, do the restock/update, but skip the
 * Stripe API call.
 */
export async function recordRefundFromWebhook(
	ctx: PluginContext,
	order: Order,
	stripeRefund: { id: string; amount: number; currency: string; reason?: string; status: string },
): Promise<Refund | null> {
	// Dedup on stripeRefundId.
	const existingRow = await refundsStore(ctx).query({
		where: { stripeRefundId: stripeRefund.id },
		limit: 1,
	});
	if (existingRow.items[0]) {
		const prev = existingRow.items[0];
		return { ...(prev.data as Refund), id: prev.id };
	}

	const amount: Money = { currency: stripeRefund.currency.toUpperCase(), amount: stripeRefund.amount };
	if (amount.currency !== order.currency) {
		ctx.log.error("Refund currency mismatch with order", {
			refundId: stripeRefund.id,
			orderId: order.id,
			refundCurrency: amount.currency,
			orderCurrency: order.currency,
		});
		return null;
	}
	const refundId = randomId();
	const refund: Refund = {
		id: refundId,
		orderId: order.id,
		amount,
		...(stripeRefund.reason ? { reason: stripeRefund.reason } : {}),
		status:
			stripeRefund.status === "succeeded"
				? "succeeded"
				: stripeRefund.status === "failed"
					? "failed"
					: "pending",
		stripeRefundId: stripeRefund.id,
		providerId: (order.providerId ?? (order.metadata?.providerId as string)) ?? "stripe",
		restocked: false,
		createdAt: new Date().toISOString(),
	};
	await refundsStore(ctx).put(refundId, refund);

	const newRefundedTotal = add(order.refundedTotal, amount);
	const paymentStatus = derivePaymentStatus(
		order.paidTotal.amount,
		newRefundedTotal.amount,
	);
	const status = deriveOrderStatusFromRefunds(
		order.status,
		order.paidTotal.amount,
		newRefundedTotal.amount,
	);
	await ordersStore(ctx).put(order.id, {
		...order,
		refundedTotal: newRefundedTotal,
		paymentStatus,
		status,
		updatedAt: new Date().toISOString(),
	});

	await sendRefundReceipt(ctx, order, refund);
	return refund;
}
