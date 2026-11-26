/**
 * Disputes (chargebacks), from a provider's normalised `dispute.updated`
 * event. Core records each dispute on its order, emails the store's admins
 * once when a new one opens, and counts a lost one like a refund. Evidence
 * is answered in the provider's dashboard; core never submits it.
 */

import type { PluginContext, StorageCollection } from "emdash";
import { sendDisputeAlert } from "../emails/dispute";
import { money } from "../money";
import { type NormalizedPaymentEvent, getPaymentProvider } from "../payment-provider";
import type { Order, OrderDispute } from "../types";
import { findOrderByPaymentIntent } from "./create";
import { recordLostDispute } from "./refund";

type OrdersStore = StorageCollection<Order>;
function ordersStore(ctx: PluginContext): OrdersStore {
	return (ctx.storage as unknown as { orders: OrdersStore }).orders;
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
	const previous = disputes.find(
		(d) => d.providerId === event.providerId && d.providerDisputeId === event.providerDisputeId,
	);
	// A settled dispute never moves again (late or out-of-order deliveries).
	if (previous && previous.status !== "open") {
		// A redelivered loss still makes sure it was counted: if the earlier
		// delivery stored the dispute but failed before counting it, the retry
		// finishes the job. Counting is keyed on the dispute, so this is safe.
		if (previous.status === "lost" && event.status === "lost") {
			await recordLostDispute(ctx, order, previous);
		}
		return "unchanged";
	}

	const now = new Date().toISOString();
	const dueAt = event.dueAt ?? previous?.dueAt;
	const reason = event.reason ?? previous?.reason;
	const dispute: OrderDispute = {
		providerId: event.providerId,
		providerDisputeId: event.providerDisputeId,
		status: event.status,
		amount: money(event.currency.toUpperCase(), event.amount),
		...(reason ? { reason } : {}),
		...(dueAt ? { dueAt } : {}),
		openedAt: previous?.openedAt ?? now,
		updatedAt: now,
	};
	const updated: Order = {
		...order,
		disputes: previous
			? disputes.map((d) => (d === previous ? dispute : d))
			: [...disputes, dispute],
		updatedAt: now,
	};
	await ordersStore(ctx).put(order.id, updated);

	if (dispute.status === "lost") {
		await recordLostDispute(ctx, updated, dispute);
		ctx.log.warn("Dispute lost; counted as a refund", {
			orderId: order.id,
			providerDisputeId: dispute.providerDisputeId,
		});
	}

	if (!previous && dispute.status === "open") {
		const label = getPaymentProvider(event.providerId)?.label ?? event.providerId;
		await sendDisputeAlert(ctx, updated, dispute, label);
		return "opened";
	}
	return "updated";
}
