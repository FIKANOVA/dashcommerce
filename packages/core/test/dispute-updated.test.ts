/**
 * Providers report disputes (chargebacks) as a normalised `dispute.updated`
 * event. Core records the dispute on the order, emails the store's admins
 * once per new open dispute, and counts a lost one like a refund.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext } from "emdash";
import {
	type NormalizedPaymentEvent,
	type PaymentProvider,
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
	stripePaymentProvider,
} from "../src/payment-provider";
import type { Order, Refund } from "../src/types";
import { deliverWebhook, makeRouteContext, startCheckout } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

const settings = {
	"settings:paymentProvider": "acme",
	"settings:checkoutMode": "hosted",
	"settings:acmeSecretKey": "acme-key",
	"settings:acmeWebhookSecret": "test-secret",
};
const headers = { "x-acme-signature": "signed" };

interface DisputeBody {
	type: "dispute";
	id: string;
	disputeId: string;
	paymentReference: string;
	status: "open" | "won" | "lost";
	amount: number;
	providerId?: string;
}

/** Mock provider that also reports disputes. */
function acme(): PaymentProvider {
	const base = createMockPaymentProvider({ id: "acme" });
	return {
		...base,
		label: "Acme Pay",
		parseWebhookEvent(raw): NormalizedPaymentEvent {
			const event = JSON.parse(raw) as DisputeBody | { type: string };
			if (event.type === "dispute") {
				const d = event as DisputeBody;
				return {
					type: "dispute.updated",
					providerId: d.providerId ?? "acme",
					providerEventId: d.id,
					providerDisputeId: d.disputeId,
					paymentReference: d.paymentReference,
					status: d.status,
					amount: d.amount,
					currency: "KES",
					reason: "fraudulent",
					dueAt: "2026-12-01T09:00:00.000Z",
					raw: event,
				};
			}
			return base.parseWebhookEvent(raw);
		},
	};
}

async function paidOrder() {
	registerPaymentProvider(acme());
	const { ctx, getCol, logs } = makeRouteContext(settings);
	const sent: Array<{ to: string; subject: string; text: string }> = [];
	Object.assign(ctx, {
		email: { send: async (m: { to: string; subject: string; text: string }) => sent.push(m) },
		users: {
			list: async (opts?: { role?: number }) => ({
				items:
					opts?.role === 50
						? [{ id: "u1", email: "owner@example.com", name: null, role: 50, createdAt: "" }]
						: [],
			}),
		},
	});
	const draftId = await startCheckout(ctx, `sess_${Math.random()}`);
	const reference = `pay_${draftId}`;
	const paid = await deliverWebhook(
		ctx,
		JSON.stringify({
			id: `evt_${draftId}`,
			type: "charge.succeeded",
			orderDraftId: draftId,
			paymentReference: reference,
			amount: 150000,
			currency: "KES",
		}),
		headers,
	);
	expect(paid.status).toBe(200);
	const order = Array.from(getCol("orders").values())[0] as unknown as Order;
	sent.length = 0; // drop the customer's order receipt
	return { ctx: ctx as PluginContext, getCol, logs, sent, order, reference };
}

function dispute(
	reference: string,
	eventId: string,
	status: DisputeBody["status"],
	extra: Partial<DisputeBody> = {},
): string {
	return JSON.stringify({
		type: "dispute",
		id: eventId,
		disputeId: "dp_1",
		paymentReference: reference,
		status,
		amount: 150000,
		...extra,
	});
}

function orderRow(getCol: (n: string) => Map<string, Record<string, unknown>>, id: string) {
	return getCol("orders").get(id) as unknown as Order;
}

describe("dispute.updated", () => {
	it("records an open dispute on the order and emails the admins once", async () => {
		const { ctx, getCol, sent, order, reference } = await paidOrder();
		const res = await deliverWebhook(ctx, dispute(reference, "evt_d1", "open"), headers);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { dispute?: string }).dispute).toBe("opened");

		const after = orderRow(getCol, order.id);
		expect(after.disputes).toHaveLength(1);
		expect(after.disputes?.[0]).toMatchObject({
			providerId: "acme",
			providerDisputeId: "dp_1",
			status: "open",
			amount: { amount: 150000, currency: "KES" },
			dueAt: "2026-12-01T09:00:00.000Z",
		});
		expect(after.refundedTotal.amount).toBe(0);
		expect(after.paymentStatus).toBe("paid");

		expect(sent).toHaveLength(1);
		expect(sent[0]?.to).toBe("owner@example.com");
		expect(sent[0]?.subject).toContain(order.orderNumber);
		expect(sent[0]?.text).toContain("Acme Pay dashboard");
		expect(sent[0]?.text).toContain("Don't ship");

		// A later update to the same dispute does not email again.
		await deliverWebhook(ctx, dispute(reference, "evt_d2", "open"), headers);
		expect(sent).toHaveLength(1);
		expect(orderRow(getCol, order.id).disputes).toHaveLength(1);
	});

	it("skips a repeat delivery of the same event", async () => {
		const { ctx, sent, reference } = await paidOrder();
		await deliverWebhook(ctx, dispute(reference, "evt_d1", "open"), headers);
		const again = await deliverWebhook(ctx, dispute(reference, "evt_d1", "open"), headers);
		expect(again.status).toBe(200);
		expect(((await again.json()) as { duplicate?: boolean }).duplicate).toBe(true);
		expect(sent).toHaveLength(1);
	});

	it("counts a lost dispute like a refund, once", async () => {
		const { ctx, getCol, order, reference } = await paidOrder();
		await deliverWebhook(ctx, dispute(reference, "evt_d1", "open"), headers);
		await deliverWebhook(ctx, dispute(reference, "evt_d2", "lost"), headers);
		await deliverWebhook(ctx, dispute(reference, "evt_d3", "lost"), headers);

		const after = orderRow(getCol, order.id);
		expect(after.disputes?.[0]?.status).toBe("lost");
		expect(after.refundedTotal.amount).toBe(150000);
		expect(after.paymentStatus).toBe("refunded");
		const refunds = Array.from(getCol("refunds").values()) as unknown as Refund[];
		expect(refunds).toHaveLength(1);
		expect(refunds[0]?.reason).toBe("Dispute lost");
	});

	it("counts a loss on retry when the first delivery stored it but failed to count it", async () => {
		const { ctx, getCol, order, reference } = await paidOrder();
		// As if the first delivery wrote the lost dispute, then failed before the refund row.
		getCol("orders").set(order.id, {
			...orderRow(getCol, order.id),
			disputes: [
				{
					providerId: "acme",
					providerDisputeId: "dp_1",
					status: "lost",
					amount: { currency: "KES", amount: 150000 },
					openedAt: "2026-11-01T00:00:00.000Z",
					updatedAt: "2026-11-01T00:00:00.000Z",
				},
			],
		});
		await deliverWebhook(ctx, dispute(reference, "evt_retry", "lost"), headers);
		const after = orderRow(getCol, order.id);
		expect(after.refundedTotal.amount).toBe(150000);
		expect(after.paymentStatus).toBe("refunded");
		expect(getCol("refunds").size).toBe(1);
	});

	it("caps a lost dispute at what is still refundable", async () => {
		const { ctx, getCol, order, reference } = await paidOrder();
		await deliverWebhook(ctx, dispute(reference, "evt_d1", "lost", { amount: 999999 }), headers);
		expect(orderRow(getCol, order.id).refundedTotal.amount).toBe(150000);
	});

	it("leaves the totals alone when the dispute is won", async () => {
		const { ctx, getCol, order, reference } = await paidOrder();
		await deliverWebhook(ctx, dispute(reference, "evt_d1", "open"), headers);
		await deliverWebhook(ctx, dispute(reference, "evt_d2", "won"), headers);
		const after = orderRow(getCol, order.id);
		expect(after.disputes?.[0]?.status).toBe("won");
		expect(after.refundedTotal.amount).toBe(0);
		expect(after.paymentStatus).toBe("paid");
		expect(getCol("refunds").size).toBe(0);
	});

	it("never moves a settled dispute back", async () => {
		const { ctx, getCol, order, reference } = await paidOrder();
		await deliverWebhook(ctx, dispute(reference, "evt_d1", "won"), headers);
		await deliverWebhook(ctx, dispute(reference, "evt_d2", "open"), headers);
		expect(orderRow(getCol, order.id).disputes?.[0]?.status).toBe("won");
	});

	it("ignores a dispute for an order another provider took", async () => {
		const { ctx, getCol, sent, order, reference } = await paidOrder();
		getCol("orders").set(order.id, { ...orderRow(getCol, order.id), providerId: "stripe" });
		const res = await deliverWebhook(ctx, dispute(reference, "evt_d1", "lost"), headers);
		expect(res.status).toBe(200);
		expect(orderRow(getCol, order.id).disputes).toBeUndefined();
		expect(orderRow(getCol, order.id).refundedTotal.amount).toBe(0);
		expect(sent).toHaveLength(0);
	});

	it("marks a dispute for an unknown payment as an orphan", async () => {
		const { ctx, sent } = await paidOrder();
		const res = await deliverWebhook(ctx, dispute("pay_unknown", "evt_d1", "open"), headers);
		expect(((await res.json()) as { orphan?: boolean }).orphan).toBe(true);
		expect(sent).toHaveLength(0);
	});
});

describe("Stripe dispute mapping", () => {
	const disputeEvent = (type: string, status: string) =>
		JSON.stringify({
			id: "evt_1",
			type,
			data: {
				object: {
					id: "dp_1",
					amount: 2000,
					currency: "usd",
					payment_intent: "pi_1",
					reason: "fraudulent",
					status,
					evidence_details: { due_by: 1764579600 },
				},
			},
		});

	it("maps charge.dispute.created to an open dispute with its deadline", () => {
		const event = stripePaymentProvider.parseWebhookEvent(
			disputeEvent("charge.dispute.created", "needs_response"),
		);
		expect(event).toMatchObject({
			type: "dispute.updated",
			providerId: "stripe",
			providerEventId: "evt_1",
			providerDisputeId: "dp_1",
			paymentReference: "pi_1",
			status: "open",
			amount: 2000,
			currency: "USD",
			dueAt: new Date(1764579600 * 1000).toISOString(),
		});
	});

	it("maps charge.dispute.closed to won or lost", () => {
		const won = stripePaymentProvider.parseWebhookEvent(
			disputeEvent("charge.dispute.closed", "won"),
		);
		const lost = stripePaymentProvider.parseWebhookEvent(
			disputeEvent("charge.dispute.closed", "lost"),
		);
		expect(won).toMatchObject({ type: "dispute.updated", status: "won" });
		expect(lost).toMatchObject({ type: "dispute.updated", status: "lost" });
	});

	it("leaves a dispute with no payment intent unhandled", () => {
		const raw = JSON.parse(disputeEvent("charge.dispute.created", "needs_response"));
		raw.data.object.payment_intent = null;
		expect(stripePaymentProvider.parseWebhookEvent(JSON.stringify(raw)).type).toBe("unhandled");
	});
});

describe("Stripe disputes through the webhook route", () => {
	const whsec = "whsec_test_dispute";

	async function stripeSignature(payload: string): Promise<string> {
		const t = Math.floor(Date.now() / 1000);
		const enc = new TextEncoder();
		const key = await crypto.subtle.importKey(
			"raw",
			enc.encode(whsec),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const mac = new Uint8Array(
			await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)),
		);
		return `t=${t},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
	}

	function stripeOrder(): Order {
		const usd = (amount: number) => ({ amount, currency: "USD" });
		return {
			id: "ord_stripe",
			orderNumber: "0001",
			status: "processing",
			paymentStatus: "paid",
			currency: "USD",
			total: usd(2000),
			paidTotal: usd(2000),
			refundedTotal: usd(0),
			stripePaymentIntentId: "pi_dispute",
		} as unknown as Order;
	}

	function event(id: string, type: string, status: string): string {
		return JSON.stringify({
			id,
			type,
			data: {
				object: {
					id: "dp_stripe",
					amount: 2000,
					currency: "usd",
					payment_intent: "pi_dispute",
					reason: "fraudulent",
					status,
					evidence_details: { due_by: 1764579600 },
				},
			},
		});
	}

	it("records an open Stripe dispute, then counts it when lost", async () => {
		const { ctx, getCol } = makeRouteContext({
			"settings:stripeSecretKey": "sk_test_1234567890abcdef",
			"settings:stripeWebhookSecret": whsec,
		});
		const sent: unknown[] = [];
		Object.assign(ctx, {
			email: { send: async (m: unknown) => sent.push(m) },
			users: {
				list: async () => ({
					items: [{ id: "u1", email: "owner@example.com", name: null, role: 50, createdAt: "" }],
				}),
			},
		});
		getCol("orders").set("ord_stripe", stripeOrder() as unknown as Record<string, unknown>);

		const created = event("evt_c", "charge.dispute.created", "needs_response");
		const res = await deliverWebhook(ctx, created, {
			"stripe-signature": await stripeSignature(created),
		});
		expect(res.status).toBe(200);
		expect(orderRow(getCol, "ord_stripe").disputes?.[0]?.status).toBe("open");
		expect(sent).toHaveLength(1);

		const closed = event("evt_l", "charge.dispute.closed", "lost");
		await deliverWebhook(ctx, closed, { "stripe-signature": await stripeSignature(closed) });
		const after = orderRow(getCol, "ord_stripe");
		expect(after.disputes?.[0]?.status).toBe("lost");
		expect(after.refundedTotal.amount).toBe(2000);
		expect(after.paymentStatus).toBe("refunded");
		expect(sent).toHaveLength(1);
	});
});
