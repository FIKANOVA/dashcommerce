/**
 * A shopper's new checkout attempt replaces their earlier one. The earlier
 * attempt must not be paid as well: on Stripe its PaymentIntent is
 * cancelled (or, when Stripe won't cancel it, the new attempt waits); on
 * any provider, a replaced attempt paid after the checkout was already
 * paid is held for review instead of becoming a second normal order.
 */

import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { RouteContext } from "emdash";
import {
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import { forgetHostedSession } from "../src/cart/lock";
import sandbox from "../src/sandbox-entry";
import type { Order, StockLock } from "../src/types";
import {
	deliverWebhook,
	makeRouteContext,
	startCheckout,
	ticketCart,
} from "./helpers/route-harness";

afterEach(() => {
	resetPaymentProviders();
	setSystemTime();
});

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});

/**
 * A Stripe Elements shop selling tickets (no stock tracking). `earlier`
 * says how Stripe answers for an earlier intent: cancellable, or not
 * (cancel refused and the intent is in `status`).
 */
function stripeShop(earlier: { cancellable: true } | { cancellable: false; status: string }) {
	let created = 0;
	const cancelled: string[] = [];
	const { ctx, kvStore } = makeRouteContext(
		{
			"settings:paymentProvider": "stripe",
			"settings:checkoutMode": "embedded",
			"settings:stripeSecretKey": "sk_test_x",
		},
		async (url, init) => {
			const cancel = url.match(/\/v1\/payment_intents\/([^/]+)\/cancel$/);
			if (cancel?.[1] && init?.method === "POST") {
				if (!earlier.cancellable) {
					return json(
						{
							error: {
								code: "payment_intent_unexpected_state",
								message: `You cannot cancel this PaymentIntent because it has a status of ${earlier.status}.`,
							},
						},
						400,
					);
				}
				cancelled.push(cancel[1]);
				return json({ id: cancel[1], status: "canceled", amount: 150000, currency: "kes" });
			}
			const retrieve = url.match(/\/v1\/payment_intents\/([^/]+)$/);
			if (retrieve?.[1] && init?.method === "GET") {
				const status = earlier.cancellable ? "canceled" : earlier.status;
				return json({ id: retrieve[1], status, amount: 150000, currency: "kes" });
			}
			if (url.endsWith("/v1/payment_intents") && init?.method === "POST") {
				created += 1;
				return json({
					id: `pi_${created}`,
					client_secret: `pi_${created}_secret`,
					amount: 150000,
					currency: "kes",
					status: "requires_payment_method",
				});
			}
			throw new Error(`Unexpected request: ${init?.method} ${url}`);
		},
	);

	async function pay(sessionId: string) {
		if (!kvStore.has(`cart:${sessionId}`)) await ctx.kv.set(`cart:${sessionId}`, ticketCart(sessionId));
		const routeCtx = {
			...ctx,
			request: new Request("http://test/checkout/create-intent", {
				method: "POST",
				headers: { Cookie: `dashcommerce_sid=${sessionId}` },
			}),
			input: {},
		} as unknown as RouteContext;
		const res = (await sandbox.routes["checkout/create-intent"].handler(routeCtx, ctx)) as Response;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	const hold = (sessionId: string) => {
		const draft = kvStore.get(`hold:${sessionId}`) as string | undefined;
		return draft ? (kvStore.get(`lock:${draft}`) as StockLock | undefined) : undefined;
	};

	return { pay, hold, cancelled, created: () => created };
}

describe("checkout/create-intent with an earlier attempt", () => {
	it("leaves a first attempt alone and records its PaymentIntent on the hold", async () => {
		const shop = stripeShop({ cancellable: true });
		const first = await shop.pay("sess_a");
		expect(first.status).toBe(200);
		expect(shop.cancelled).toEqual([]);
		expect(shop.hold("sess_a")?.stripePaymentIntentId).toBe("pi_1");
	});

	it("cancels the earlier attempt's PaymentIntent before starting a new one", async () => {
		const shop = stripeShop({ cancellable: true });
		expect((await shop.pay("sess_a")).status).toBe(200);

		const second = await shop.pay("sess_a");
		expect(second.status).toBe(200);
		expect(second.body.paymentIntentId).toBe("pi_2");
		expect(shop.cancelled).toEqual(["pi_1"]);
		expect(shop.hold("sess_a")?.stripePaymentIntentId).toBe("pi_2");
	});

	it("refuses the new attempt while the earlier payment can't be cancelled", async () => {
		const shop = stripeShop({ cancellable: false, status: "processing" });
		const first = await shop.pay("sess_a");
		expect(first.status).toBe(200);

		const second = await shop.pay("sess_a");
		expect(second.status).toBe(409);
		expect(second.body.code).toBe("earlier_payment_processing");
		expect(second.body.error).toBe(
			"Your earlier payment is still being processed. Wait a moment, then check your email or try again.",
		);
		// No second intent, and the earlier attempt keeps its hold.
		expect(shop.created()).toBe(1);
		expect(shop.hold("sess_a")?.orderDraftId).toBe(first.body.orderDraftId as string);
	});

	it("refuses the new attempt when the earlier payment already succeeded", async () => {
		const shop = stripeShop({ cancellable: false, status: "succeeded" });
		expect((await shop.pay("sess_a")).status).toBe(200);
		const second = await shop.pay("sess_a");
		expect(second.status).toBe(409);
		expect(second.body.code).toBe("earlier_payment_processing");
	});
});

/**
 * A shop on hosted Stripe Checkout. `earlier` says how Stripe answers for
 * an earlier session: expirable, or not (expire refused and the session is
 * in `status`).
 */
function hostedStripeShop(earlier: { expirable: true } | { expirable: false; status: string }) {
	let created = 0;
	const expired: string[] = [];
	const bodies: URLSearchParams[] = [];
	const { ctx, kvStore } = makeRouteContext(
		{
			"settings:paymentProvider": "stripe",
			"settings:checkoutMode": "hosted",
			"settings:stripeSecretKey": "sk_test_x",
		},
		async (url, init) => {
			const expire = url.match(/\/v1\/checkout\/sessions\/([^/]+)\/expire$/);
			if (expire?.[1] && init?.method === "POST") {
				if (!earlier.expirable) {
					return json(
						{
							error: {
								code: "checkout_session_unexpected_state",
								message: `This Checkout Session has a status of ${earlier.status} and can't be expired.`,
							},
						},
						400,
					);
				}
				expired.push(expire[1]);
				return json({ id: expire[1], object: "checkout.session", status: "expired" });
			}
			const retrieve = url.match(/\/v1\/checkout\/sessions\/([^/]+)$/);
			if (retrieve?.[1] && init?.method === "GET") {
				const status = earlier.expirable ? "expired" : earlier.status;
				return json({ id: retrieve[1], object: "checkout.session", status });
			}
			if (url.endsWith("/v1/checkout/sessions") && init?.method === "POST") {
				created += 1;
				bodies.push(new URLSearchParams(String(init.body ?? "")));
				return json({
					id: `cs_${created}`,
					object: "checkout.session",
					mode: "payment",
					status: "open",
					url: `https://checkout.stripe.com/c/pay/cs_${created}`,
				});
			}
			throw new Error(`Unexpected request: ${init?.method} ${url}`);
		},
	);

	async function pay(sessionId: string) {
		// The shopper comes back from Stripe's page to the same cart.
		await ctx.kv.set(`cart:${sessionId}`, ticketCart(sessionId));
		const routeCtx = {
			...ctx,
			request: new Request("http://test/checkout/create-session", {
				method: "POST",
				headers: { Cookie: `dashcommerce_sid=${sessionId}` },
			}),
			input: {},
		} as unknown as RouteContext;
		const res = (await sandbox.routes["checkout/create-session"].handler(routeCtx, ctx)) as Response;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	const hold = (sessionId: string) => {
		const draft = kvStore.get(`hold:${sessionId}`) as string | undefined;
		return draft ? (kvStore.get(`lock:${draft}`) as StockLock | undefined) : undefined;
	};

	return { ctx, pay, hold, expired, bodies, created: () => created };
}

describe("checkout/create-session (hosted Stripe) with an earlier attempt", () => {
	it("records the Checkout Session on the hold", async () => {
		const shop = hostedStripeShop({ expirable: true });
		expect((await shop.pay("sess_h")).status).toBe(200);
		expect(shop.expired).toEqual([]);
		expect(shop.hold("sess_h")?.stripeCheckoutSessionId).toBe("cs_1");
	});

	it("expires the earlier attempt's Checkout Session before starting a new one", async () => {
		const shop = hostedStripeShop({ expirable: true });
		expect((await shop.pay("sess_h")).status).toBe(200);

		const second = await shop.pay("sess_h");
		expect(second.status).toBe(200);
		expect(second.body.sessionId).toBe("cs_2");
		expect(shop.expired).toEqual(["cs_1"]);
		expect(shop.hold("sess_h")?.stripeCheckoutSessionId).toBe("cs_2");
	});

	it("keeps the 15-minute hold and Stripe's own session lifetime", async () => {
		const start = new Date("2026-11-27T10:00:00Z");
		setSystemTime(start);
		const shop = hostedStripeShop({ expirable: true });
		expect((await shop.pay("sess_h")).status).toBe(200);
		expect(shop.bodies[0]?.has("expires_at")).toBe(false);
		expect(Date.parse(shop.hold("sess_h")?.expiresAt ?? "")).toBe(start.getTime() + 15 * 60 * 1000);
	});

	for (const [after, ms] of [
		["20 minutes", 20 * 60 * 1000],
		["5 hours", 5 * 60 * 60 * 1000],
	] as const) {
		it(`still expires the earlier session on a retry ${after} later, after the hold ended`, async () => {
			const start = new Date("2026-11-27T10:00:00Z");
			setSystemTime(start);
			const shop = hostedStripeShop({ expirable: true });
			expect((await shop.pay("sess_h")).status).toBe(200);

			setSystemTime(new Date(start.getTime() + ms));
			expect(shop.hold("sess_h") && Date.parse(shop.hold("sess_h")?.expiresAt ?? "") > Date.now()).toBe(false);
			const second = await shop.pay("sess_h");
			expect(second.status).toBe(200);
			expect(shop.expired).toEqual(["cs_1"]);
		});
	}

	it("doesn't hold a new purchase back once the earlier checkout's order exists", async () => {
		const shop = hostedStripeShop({ expirable: false, status: "complete" });
		const first = await shop.pay("sess_h");
		// Order creation forgets the pointer (and releases the hold).
		await forgetHostedSession(shop.ctx, "sess_h", first.body.orderDraftId as string);
		await shop.ctx.kv.delete("hold:sess_h");
		expect((await shop.pay("sess_h")).status).toBe(200);
	});

	it("refuses the new attempt when the earlier session is already complete", async () => {
		const shop = hostedStripeShop({ expirable: false, status: "complete" });
		const first = await shop.pay("sess_h");
		expect(first.status).toBe(200);

		const second = await shop.pay("sess_h");
		expect(second.status).toBe(409);
		expect(second.body.code).toBe("earlier_payment_processing");
		// No second session, and the earlier attempt keeps its hold.
		expect(shop.created()).toBe(1);
		expect(shop.hold("sess_h")?.orderDraftId).toBe(first.body.orderDraftId as string);
	});
});

const mockSettings = {
	"settings:paymentProvider": "mock",
	"settings:checkoutMode": "hosted",
	"settings:mockSecretKey": "mock-secret-key",
	"settings:mockWebhookSecret": "test-secret",
};

function chargeSucceeded(orderDraftId: string, n: number): string {
	return JSON.stringify({
		id: `evt_${n}`,
		type: "charge.succeeded",
		orderDraftId,
		paymentReference: `pay_${n}`,
		amount: 150000,
		currency: "KES",
		email: "supporter@example.com",
	});
}

const headers = { "x-mock-signature": "signed" };

describe("a replaced attempt paid late (e.g. a pending M-PESA prompt)", () => {
	it("is held for review when the checkout was already paid", async () => {
		registerPaymentProvider(createMockPaymentProvider());
		const { ctx, getCol } = makeRouteContext(mockSettings);
		const first = await startCheckout(ctx, "sess_m");
		const second = await startCheckout(ctx, "sess_m");

		expect((await deliverWebhook(ctx, chargeSucceeded(second, 2), headers)).status).toBe(200);
		expect((await deliverWebhook(ctx, chargeSucceeded(first, 1), headers)).status).toBe(200);

		const orders = [...getCol("orders").values()] as unknown as Order[];
		expect(orders).toHaveLength(2);
		const paidFirst = orders.find((o) => o.paymentReference === "pay_2");
		const paidLate = orders.find((o) => o.paymentReference === "pay_1");
		expect(paidFirst?.status).toBe("processing");
		expect(paidLate?.status).toBe("on-hold");
		expect(paidLate?.metadata?.duplicateOfOrderId).toBe(paidFirst?.id);
	});

	it("holds the newer attempt too when the replaced one was paid first", async () => {
		registerPaymentProvider(createMockPaymentProvider());
		const { ctx, getCol } = makeRouteContext(mockSettings);
		const first = await startCheckout(ctx, "sess_m");
		const second = await startCheckout(ctx, "sess_m");

		await deliverWebhook(ctx, chargeSucceeded(first, 1), headers);
		await deliverWebhook(ctx, chargeSucceeded(second, 2), headers);

		const orders = [...getCol("orders").values()] as unknown as Order[];
		expect(orders.find((o) => o.paymentReference === "pay_1")?.status).toBe("processing");
		expect(orders.find((o) => o.paymentReference === "pay_2")?.status).toBe("on-hold");
	});

	it("becomes a normal order when it is the only attempt paid", async () => {
		registerPaymentProvider(createMockPaymentProvider());
		const { ctx, getCol } = makeRouteContext(mockSettings);
		const first = await startCheckout(ctx, "sess_m");
		await startCheckout(ctx, "sess_m");

		await deliverWebhook(ctx, chargeSucceeded(first, 1), headers);

		const orders = [...getCol("orders").values()] as unknown as Order[];
		expect(orders).toHaveLength(1);
		expect(orders[0]?.status).toBe("processing");
		expect(orders[0]?.metadata?.duplicateOfOrderId).toBeUndefined();
	});
});
