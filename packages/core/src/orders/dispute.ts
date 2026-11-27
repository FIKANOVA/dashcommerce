/**
 * Disputes (chargebacks), from a provider's normalised `dispute.updated`
 * event. Core records each dispute on its order, emails the store's admins
 * once when it first sees one (whatever its status), and counts a lost one
 * like a refund. A lost dispute that later turns won stops counting.
 * Evidence is answered in the provider's dashboard; core never submits it.
 *
 * A dispute on a subscription renewal has no order (renewals are stored as
 * subscription invoices). It is recorded on that invoice and alerted, but not
 * counted against any order: the order holds only the first payment.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { type DisputedPayment, sendDisputeAlert } from "../emails/dispute";
import { money } from "../money";
import { type NormalizedPaymentEvent, getPaymentProvider } from "../payment-provider";
import type { Customer, Order, OrderDispute, Subscription, SubscriptionInvoice } from "../types";
import { findOrderByPaymentIntent, loadOrder } from "./create";
import { recordLostDispute, reverseLostDispute } from "./refund";

type OrdersStore = StorageCollection<Order>;
function ordersStore(ctx: PluginContext): OrdersStore {
	return (ctx.storage as unknown as { orders: OrdersStore }).orders;
}

type InvoiceStore = StorageCollection<SubscriptionInvoice>;
function invoiceStore(ctx: PluginContext): InvoiceStore {
	return (ctx.storage as unknown as { subscription_invoices: InvoiceStore })
		.subscription_invoices;
}

export type DisputeEvent = Extract<NormalizedPaymentEvent, { type: "dispute.updated" }>;

export type DisputeUpdateOutcome =
	| "opened"
	| "updated"
	| "unchanged"
	| "unknown"
	| "other-provider";

export async function applyDisputeUpdate(
	ctx: PluginContext,
	event: DisputeEvent,
): Promise<DisputeUpdateOutcome> {
	const order = await findOrderByPaymentIntent(ctx, event.paymentReference);
	if (!order) {
		const invoice = await findRenewalInvoice(ctx, event.providerId, event.paymentReference);
		if (invoice) return applyRenewalDispute(ctx, event, invoice);
		ctx.log.warn("Dispute for a payment with no order", {
			providerId: event.providerId,
			providerDisputeId: event.providerDisputeId,
			paymentReference: event.paymentReference,
		});
		return "unknown";
	}
	if ((order.providerId ?? "stripe") !== event.providerId) {
		ctx.log.warn("Dispute from a provider that did not take the payment", {
			providerId: event.providerId,
			providerDisputeId: event.providerDisputeId,
			orderId: order.id,
		});
		return "other-provider";
	}

	const disputes = order.disputes ?? [];
	const previous = findDispute(disputes, event);
	// A settled dispute never moves again (late or out-of-order deliveries),
	// except a loss the provider later reverses in the store's favour.
	if (previous && previous.status !== "open") {
		// A redelivered loss still makes sure it was counted: if the earlier
		// delivery stored the dispute but failed before counting it, the retry
		// finishes the job. Counting is keyed on the dispute, so this is safe.
		if (previous.status === "lost" && event.status === "lost") {
			await recordLostDispute(ctx, order, previous);
		}
		if (previous.status === "lost" && event.status === "won") {
			return applyLostThenWon(ctx, order, previous);
		}
		return "unchanged";
	}

	const dispute = nextDispute(event, previous);
	const updated: Order = {
		...order,
		disputes: replaceDispute(disputes, previous, dispute),
		updatedAt: dispute.updatedAt,
	};
	await ordersStore(ctx).put(order.id, updated);

	if (dispute.status === "lost") {
		await recordLostDispute(ctx, updated, dispute);
		ctx.log.warn("Dispute lost; counted as a refund", {
			orderId: order.id,
			providerDisputeId: dispute.providerDisputeId,
		});
		if (hasVendorShares(updated)) {
			// Vendors were paid their shares when the payment was split; the
			// provider took the whole disputed amount back from the store.
			ctx.log.warn("Dispute lost on a split payment; vendor shares were not taken back", {
				orderId: order.id,
				providerDisputeId: dispute.providerDisputeId,
			});
		}
	}

	if (!previous) {
		await sendDisputeAlert(ctx, updated, dispute, dispute.providerLabel ?? event.providerId);
		return "opened";
	}
	return "updated";
}

/** True when part of the order's payment went to vendors (Stripe Connect or provider splits). */
export function hasVendorShares(order: Order): boolean {
	return (
		(order.vendorSplits?.length ?? 0) > 0 || (order.providerSplits?.allocations.length ?? 0) > 0
	);
}

/**
 * A lost dispute turned won: stop counting it as a refund, then record the
 * new status. In that order, so a failure in between leaves the dispute
 * lost and the provider's retry finishes the reversal.
 */
async function applyLostThenWon(
	ctx: PluginContext,
	order: Order,
	previous: OrderDispute,
): Promise<DisputeUpdateOutcome> {
	await reverseLostDispute(ctx, order, previous);
	const fresh = (await loadOrder(ctx, order.id)) ?? order;
	const now = new Date().toISOString();
	const won: OrderDispute = { ...previous, status: "won", updatedAt: now };
	const disputes = fresh.disputes ?? [];
	await ordersStore(ctx).put(order.id, {
		...fresh,
		disputes: replaceDispute(disputes, findDispute(disputes, previous), won),
		updatedAt: now,
	});
	ctx.log.warn("Lost dispute turned won; no longer counted as a refund", {
		orderId: order.id,
		providerDisputeId: previous.providerDisputeId,
	});
	return "updated";
}

async function findRenewalInvoice(
	ctx: PluginContext,
	providerId: string,
	paymentReference: string,
): Promise<SubscriptionInvoice | null> {
	// Provider renewals are stored under `${providerId}:${reference}`.
	const result = await invoiceStore(ctx).query({
		where: { stripeInvoiceId: `${providerId}:${paymentReference}` },
		limit: 1,
	});
	const row = result.items[0];
	return row ? { ...(row.data as SubscriptionInvoice), id: row.id } : null;
}

/**
 * A dispute on a subscription renewal: recorded on the renewal's invoice and
 * alerted with the customer's email, never counted against an order.
 */
async function applyRenewalDispute(
	ctx: PluginContext,
	event: DisputeEvent,
	invoice: SubscriptionInvoice,
): Promise<DisputeUpdateOutcome> {
	const disputes = invoice.disputes ?? [];
	const previous = findDispute(disputes, event);
	// Nothing was counted for a renewal, so a lost one may still turn won.
	const lostThenWon = previous?.status === "lost" && event.status === "won";
	if (previous && previous.status !== "open" && !lostThenWon) return "unchanged";

	const dispute = nextDispute(event, previous);
	await invoiceStore(ctx).put(invoice.id, {
		...invoice,
		disputes: replaceDispute(disputes, previous, dispute),
	});
	const logFields = {
		subscriptionId: invoice.subscriptionId,
		invoiceId: invoice.id,
		providerDisputeId: dispute.providerDisputeId,
	};
	if (dispute.status === "lost") {
		ctx.log.warn("Dispute lost on a subscription renewal; not counted against any order", logFields);
	}
	if (previous) return "updated";

	ctx.log.warn("Dispute on a subscription renewal", logFields);
	const customerEmail = await renewalCustomerEmail(ctx, invoice.subscriptionId);
	const payment: DisputedPayment = {
		kind: "renewal",
		paymentReference: event.paymentReference,
		subscriptionId: invoice.subscriptionId,
		...(customerEmail ? { customerEmail } : {}),
	};
	await sendDisputeAlert(ctx, payment, dispute, dispute.providerLabel ?? event.providerId);
	return "opened";
}

async function renewalCustomerEmail(
	ctx: PluginContext,
	subscriptionId: string,
): Promise<string | undefined> {
	const storage = ctx.storage as unknown as {
		subscriptions: StorageCollection<Subscription>;
		customers: StorageCollection<Customer>;
	};
	const sub = await storage.subscriptions.get(subscriptionId);
	if (!sub) return undefined;
	const customer = await storage.customers.get(sub.customerId);
	return customer?.email || undefined;
}

function findDispute(
	disputes: OrderDispute[],
	key: { providerId: string; providerDisputeId: string },
): OrderDispute | undefined {
	return disputes.find(
		(d) => d.providerId === key.providerId && d.providerDisputeId === key.providerDisputeId,
	);
}

function replaceDispute(
	disputes: OrderDispute[],
	previous: OrderDispute | undefined,
	next: OrderDispute,
): OrderDispute[] {
	return previous ? disputes.map((d) => (d === previous ? next : d)) : [...disputes, next];
}

function nextDispute(event: DisputeEvent, previous: OrderDispute | undefined): OrderDispute {
	const now = new Date().toISOString();
	const dueAt = event.dueAt ?? previous?.dueAt;
	const reason = event.reason ?? previous?.reason;
	const providerLabel = getPaymentProvider(event.providerId)?.label ?? previous?.providerLabel;
	return {
		providerId: event.providerId,
		providerDisputeId: event.providerDisputeId,
		status: event.status,
		amount: money(event.currency.toUpperCase(), event.amount),
		...(providerLabel ? { providerLabel } : {}),
		...(reason ? { reason } : {}),
		...(dueAt ? { dueAt } : {}),
		openedAt: previous?.openedAt ?? now,
		updatedAt: now,
	};
}
