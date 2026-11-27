/**
 * After a hosted Stripe payment, the order's ship-to region is the one the
 * cart priced shipping on, not Stripe's free-text state. With no region on
 * the cart, a state name the shop knows is stored as its ISO code.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import type { CheckoutDraftSnapshot } from "../src/routes/checkout";
import type { Order } from "../src/types";
import { deliverWebhook, makeRouteContext, startCheckout } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

const whsec = "whsec_test_region";

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
	const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)));
	return `t=${t},v1=${Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Pay a checkout whose cart ship-to region is `cartRegion`, with Stripe
 * reporting `state` on both addresses. Returns the order.
 */
async function payWithStripe(cartRegion: string, state: string, billingState = state) {
	// The mock provider only stores the draft; the payment arrives as Stripe's.
	registerPaymentProvider(createMockPaymentProvider(), { override: true });
	const { ctx, getCol, kvStore } = makeRouteContext(
		{
			"settings:paymentProvider": "mock",
			"settings:checkoutMode": "hosted",
			"settings:mockSecretKey": "mock-secret-key",
			"settings:mockWebhookSecret": "test-secret",
			"settings:stripeSecretKey": "sk_test_region",
			"settings:stripeWebhookSecret": whsec,
		},
		async (url) => {
			if (!url.startsWith("https://api.stripe.com/v1/payment_intents/pi_region")) {
				throw new Error(`Unexpected Stripe call: ${url}`);
			}
			return new Response(
				JSON.stringify({
					id: "pi_region",
					object: "payment_intent",
					amount: 150000,
					amount_received: 150000,
					currency: "kes",
					status: "succeeded",
					metadata: { orderDraftId: draftId },
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		},
	);
	const draftId = await startCheckout(ctx, "sess_region");
	const key = `draft:${draftId}`;
	const draft = kvStore.get(key) as CheckoutDraftSnapshot;
	const shipTo = { ...draft.cart.shippingAddress, country: "KE", region: cartRegion };
	kvStore.set(key, { ...draft, cart: { ...draft.cart, shippingAddress: shipTo } });

	const address = (s: string) => ({ line1: "Moi Avenue", city: "Nairobi", state: s, country: "KE" });
	const payload = JSON.stringify({
		id: "evt_region",
		type: "checkout.session.completed",
		data: {
			object: {
				id: "cs_region",
				object: "checkout.session",
				mode: "payment",
				payment_status: "paid",
				payment_intent: "pi_region",
				amount_total: 150000,
				currency: "kes",
				metadata: { orderDraftId: draftId },
				customer_details: {
					email: "supporter@example.com",
					name: "Wanjiru Kamau",
					address: address(billingState),
				},
				shipping_details: { name: "Wanjiru Kamau", address: address(state) },
			},
		},
	});
	const res = await deliverWebhook(ctx, payload, { "stripe-signature": await stripeSignature(payload) });
	expect(res.status).toBe(200);
	const orders = [...getCol("orders").values()] as unknown as Order[];
	expect(orders).toHaveLength(1);
	return orders[0] as Order;
}

describe("the order's region after a hosted Stripe payment", () => {
	it("keeps the region the cart priced shipping on", async () => {
		const order = await payWithStripe("30", "Mombasa");
		expect(order.shippingAddress.region).toBe("30");
		// Billing isn't priced on a zone: Stripe's state, as its code.
		expect(order.billingAddress.region).toBe("28");
	});

	it("maps Stripe's state name to its ISO code when the cart has no region", async () => {
		const order = await payWithStripe("", "Nairobi", "Nairobi County");
		expect(order.shippingAddress.region).toBe("30");
		expect(order.billingAddress.region).toBe("30");
	});

	it("keeps a state the shop has no name for as Stripe sent it", async () => {
		const order = await payWithStripe("", "Somewhere");
		expect(order.shippingAddress.region).toBe("Somewhere");
	});
});
