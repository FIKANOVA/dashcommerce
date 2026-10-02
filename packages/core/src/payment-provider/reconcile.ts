/**
 * Asynchronous payment status reconciliation helper.
 *
 * Checks payment status with the active provider, reconciles pending attempts,
 * prevents duplicate order creation, and handles late confirmation after
 * initial draft/polling windows.
 */

import type { PluginContext } from "emdash";
import { deleteLock, getLock } from "../cart/lock";
import { clear as clearCart } from "../cart/store";
import { createOrderFromPaymentIntent, findOrderByOrderDraftId } from "../orders/create";
import { type CheckoutDraftSnapshot, draftKey } from "../routes/checkout";
import type { StripePaymentIntent } from "../stripe/payment-intents";
import { getPaymentProvider } from "./registry";
import { toPaymentProviderRuntimeContext } from "./runtime";

export interface ReconcileAttemptInput {
	orderDraftId: string;
	providerId?: string;
}

export interface ReconcileAttemptResult {
	status: "pending" | "completed" | "failed" | "expired";
	orderId?: string;
	orderNumber?: string;
	reconciled?: boolean;
	duplicatePayment?: boolean;
	reason?: string;
}

export async function reconcilePaymentAttempt(
	ctx: PluginContext,
	input: ReconcileAttemptInput,
): Promise<ReconcileAttemptResult> {
	const { orderDraftId } = input;

	// 1. Check if an order was already completed for this draft
	const existing = await findOrderByOrderDraftId(ctx, orderDraftId);
	if (existing) {
		return {
			status: "completed",
			orderId: existing.id,
			orderNumber: existing.orderNumber,
			reconciled: false,
		};
	}

	// 2. Fetch draft snapshot
	const snapshot = await ctx.kv.get<CheckoutDraftSnapshot>(draftKey(orderDraftId));
	if (!snapshot) {
		return {
			status: "expired",
			reason: "Draft snapshot expired or not found",
		};
	}

	const providerId = input.providerId ?? snapshot.providerId ?? "stripe";
	const provider = getPaymentProvider(providerId);
	if (!provider || !provider.getPaymentStatus) {
		return {
			status: "pending",
			reason: `Provider ${providerId} does not support status lookup; awaiting webhook`,
		};
	}

	const secret =
		(await ctx.kv.get<string>(`settings:${provider.id}SecretKey`)) ??
		(provider.id.includes("mock") ? "test-secret" : "");
	const creds = { secretKey: secret };

	const runtimeCtx = toPaymentProviderRuntimeContext(ctx);
	const targetRef = snapshot.checkoutReference ?? `ref_${orderDraftId}`;
	const providerStatus = await provider.getPaymentStatus(runtimeCtx, targetRef, creds);

	if (providerStatus.status === "pending") {
		return { status: "pending" };
	}

	if (providerStatus.status === "failed") {
		// Release stock lock on failure
		const lock = await getLock(ctx, orderDraftId);
		if (lock) await deleteLock(ctx, orderDraftId);
		return {
			status: "failed",
			reason: providerStatus.reason ?? "Provider indicated payment failure",
		};
	}

	if (providerStatus.status === "succeeded") {
		// Double check idempotency before creating order
		const doubleCheck = await findOrderByOrderDraftId(ctx, orderDraftId);
		if (doubleCheck) {
			// Record duplicate payment reconciliation rather than creating duplicate fulfilment
			ctx.log.warn("Late payment arrived for already-completed order", {
				orderId: doubleCheck.id,
				orderDraftId,
				paymentReference: providerStatus.paymentReference,
			});
			return {
				status: "completed",
				orderId: doubleCheck.id,
				orderNumber: doubleCheck.orderNumber,
				duplicatePayment: true,
			};
		}

		const paymentRef = providerStatus.paymentReference ?? `rec_${orderDraftId}`;
		const syntheticPi: StripePaymentIntent = {
			id: paymentRef,
			amount: providerStatus.amount ?? snapshot.cart.total.amount,
			amount_received: providerStatus.amount ?? snapshot.cart.total.amount,
			currency: (providerStatus.currency ?? snapshot.cart.currency).toLowerCase(),
			status: "succeeded",
			receipt_email: snapshot.cart.customerEmail,
			metadata: {
				orderDraftId,
				providerId: provider.id,
				checkoutReference: snapshot.checkoutReference ?? "",
			},
		};

		const { order } = await createOrderFromPaymentIntent(ctx, {
			paymentIntent: syntheticPi,
			cartSnapshot: snapshot.cart,
			orderDraftId,
		});

		// Cleanup draft snapshot and lock
		await ctx.kv.delete(draftKey(orderDraftId));
		const lock = await getLock(ctx, orderDraftId);
		if (lock) await deleteLock(ctx, orderDraftId);
		if (snapshot.cart.sessionId) {
			await clearCart(ctx, snapshot.cart.sessionId);
		}

		return {
			status: "completed",
			orderId: order.id,
			orderNumber: order.orderNumber,
			reconciled: true,
		};
	}

	return { status: "pending" };
}
