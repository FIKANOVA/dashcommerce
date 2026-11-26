/**
 * Stripe Elements fixes the amount when the customer presses Pay, like
 * every other checkout: the card form starts without a PaymentIntent, and
 * checkout/create-intent prices the cart at that moment. Pressing Pay
 * again must not lock the shopper out of the stock they already hold.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { RouteContext } from "emdash";
import {
	type PayableCart,
	cartReadyForPayment,
	deferredElementsOptions,
} from "../src/astro/islands/CheckoutFormIsland";
import { deleteLock } from "../src/cart/lock";
import {
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import sandbox from "../src/sandbox-entry";
import type { CartState } from "../src/types";
import { makeRouteContext } from "./helpers/route-harness";

const kes = (amount: number) => ({ amount, currency: "KES" });

describe("the card form before Pay", () => {
	const cart: PayableCart = {
		customerEmail: "buyer@example.com",
		shippingAddress: { country: "KE" },
		total: kes(174615),
		currency: "KES",
		updatedAt: "2026-11-26T09:00:00.000Z",
	};

	it("waits for the contact step", () => {
		expect(cartReadyForPayment(cart)).toBe(true);
		expect(cartReadyForPayment({ ...cart, customerEmail: undefined })).toBe(false);
		expect(cartReadyForPayment({ ...cart, shippingAddress: undefined })).toBe(false);
	});

	it("starts Stripe Elements in payment mode with the cart's amount, no intent", () => {
		expect(deferredElementsOptions(cart)).toEqual({
			mode: "payment",
			amount: 174615,
			currency: "kes",
		});
	});
});

/** A shop on Stripe Elements selling one mug, with exactly one left. */
function shop(settings: Record<string, unknown> = {}) {
	let created = 0;
	const { ctx, kvStore } = makeRouteContext(
		{
			"settings:paymentProvider": "stripe",
			"settings:checkoutMode": "embedded",
			"settings:stripeSecretKey": "sk_test_x",
			...settings,
		},
		async (url, init) => {
			if (url.includes("/v1/payment_intents") && init?.method === "POST") {
				created += 1;
				const params = new URLSearchParams(String(init.body ?? ""));
				return new Response(
					JSON.stringify({
						id: `pi_${created}`,
						client_secret: `pi_${created}_secret`,
						amount: Number(params.get("amount")),
						currency: params.get("currency"),
						status: "requires_payment_method",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			throw new Error(`Unexpected request: ${url}`);
		},
	);
	(ctx as unknown as { content: unknown }).content = {
		async get(collection: string, id: string) {
			if (collection !== "products" || id !== "prod_mug") return null;
			return {
				id: "prod_mug",
				status: "published",
				data: {
					title: "Enamel Mug",
					type: "simple",
					prices: { KES: { amount: 50000 } },
					manage_stock: true,
					stock_quantity: 1,
				},
			};
		},
	};

	async function addShopper(sessionId: string) {
		const address = {
			firstName: "A",
			lastName: "B",
			line1: "Ngong Road",
			city: "Nairobi",
			region: "",
			postalCode: "",
			country: "KE",
		};
		const cart = {
			sessionId,
			currency: "KES",
			customerEmail: "buyer@example.com",
			billingAddress: address,
			shippingAddress: address,
			items: [
				{
					lineId: "l1",
					productId: "prod_mug",
					quantity: 1,
					title: "Enamel Mug",
					isDigital: false,
					unitPrice: kes(50000),
					lineSubtotal: kes(50000),
				},
			],
			coupons: [],
			taxLines: [],
			subtotal: kes(50000),
			discountTotal: kes(0),
			shippingTotal: kes(0),
			taxTotal: kes(0),
			total: kes(50000),
			shippingMethod: { id: "pickup", label: "Store pickup", amount: kes(0) },
			createdAt: "2026-11-26T08:00:00.000Z",
			updatedAt: "2026-11-26T08:00:00.000Z",
		} as unknown as CartState;
		await ctx.kv.set(`cart:${sessionId}`, cart);
	}

	async function pay(
		sessionId: string,
		input: Record<string, unknown> = {},
		route: "checkout/create-intent" | "checkout/create-session" = "checkout/create-intent",
	) {
		const routeCtx = {
			...ctx,
			request: new Request(`http://test/${route}`, {
				method: "POST",
				headers: { Cookie: `dashcommerce_sid=${sessionId}` },
			}),
			input,
		} as unknown as RouteContext;
		const res = (await sandbox.routes[route].handler(routeCtx, ctx)) as Response;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	const locksFor = (sessionId: string) =>
		[...kvStore.entries()]
			.filter(
				([key, value]) =>
					key.startsWith("lock:") && (value as { sessionId: string }).sessionId === sessionId,
			)
			.map(([, value]) => (value as { orderDraftId: string }).orderDraftId);

	return { ctx, kvStore, addShopper, pay, locksFor };
}

describe("checkout/create-intent", () => {
	it("lets a shopper press Pay again without their own hold blocking the last unit", async () => {
		const { addShopper, pay, locksFor } = shop();
		await addShopper("sess_a");
		const first = await pay("sess_a");
		expect(first.status).toBe(200);

		const second = await pay("sess_a");
		expect(second.status).toBe(200);
		// One hold per shopper: the second attempt replaced the first.
		expect(locksFor("sess_a")).toEqual([second.body.orderDraftId as string]);
	});

	it("still holds the last unit against other shoppers", async () => {
		const { addShopper, pay } = shop();
		await addShopper("sess_a");
		await addShopper("sess_b");
		expect((await pay("sess_a")).status).toBe(200);
		const other = await pay("sess_b");
		expect(other.status).toBe(409);
		expect(JSON.stringify(other.body)).toContain("only 0 available");
	});
});

afterEach(() => resetPaymentProviders());

describe("the total the customer saw", () => {
	it("is charged when it still stands", async () => {
		const { addShopper, pay } = shop();
		await addShopper("sess_a");
		const res = await pay("sess_a", { expectedTotal: kes(50000) });
		expect(res.status).toBe(200);
		expect(res.body.total).toEqual(kes(50000));
	});

	it("is refused when the cart now costs something else, with the new total to show", async () => {
		const { addShopper, pay } = shop();
		await addShopper("sess_a");
		const res = await pay("sess_a", { expectedTotal: kes(45000) });
		expect(res.status).toBe(409);
		expect(res.body.code).toBe("cart_totals_changed");
		expect((res.body.cart as CartState).total).toEqual(kes(50000));
	});
});

describe("holds across attempts", () => {
	it("holds the stock again after a decline released the hold, and forgets released holds", async () => {
		const { ctx, kvStore, addShopper, pay, locksFor } = shop();
		await addShopper("sess_a");
		const first = await pay("sess_a");
		const draft = first.body.orderDraftId as string;
		expect(kvStore.get("hold:sess_a")).toBe(draft);

		// A decline (payment_intent.payment_failed) releases the hold.
		await deleteLock(ctx, draft);
		expect(locksFor("sess_a")).toEqual([]);
		expect(kvStore.has("hold:sess_a")).toBe(false);

		const retry = await pay("sess_a");
		expect(retry.status).toBe(200);
		expect(locksFor("sess_a")).toEqual([retry.body.orderDraftId as string]);
	});

	it("lets a shopper press Pay again on hosted checkout too", async () => {
		registerPaymentProvider(createMockPaymentProvider());
		const { ctx, addShopper, pay, locksFor } = shop({
			"settings:paymentProvider": "mock",
			"settings:checkoutMode": "hosted",
			"settings:mockSecretKey": "k",
			"settings:mockWebhookSecret": "test-secret",
		});
		await addShopper("sess_a");
		const first = await pay("sess_a", {}, "checkout/create-session");
		expect(first.status).toBe(200);
		// The test shop has no shipping zones, so re-pricing drops the
		// made-up option; put it back as a real chosen option would stay.
		const stored = (await ctx.kv.get<CartState>("cart:sess_a")) as CartState;
		await ctx.kv.set("cart:sess_a", {
			...stored,
			shippingMethod: { id: "pickup", label: "Store pickup", amount: kes(0) },
		});
		const second = await pay("sess_a", {}, "checkout/create-session");
		expect(second.status).toBe(200);
		expect(locksFor("sess_a")).toHaveLength(1);
	});
});
