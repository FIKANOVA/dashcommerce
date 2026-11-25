/**
 * Shipping zones match on country and region only, and many addresses
 * have no postcode, so checkout must not require one.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { RouteContext } from "emdash";
import {
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import sandbox from "../src/sandbox-entry";
import type { CartState } from "../src/types";
import { makeRouteContext, ticketCart } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

const settings = {
	"settings:paymentProvider": "mock",
	"settings:checkoutMode": "hosted",
	"settings:mockSecretKey": "k",
	"settings:mockWebhookSecret": "test-secret",
};

function routeContext(ctx: unknown, path: string, sessionId: string, input: unknown) {
	return {
		...(ctx as object),
		request: new Request(`http://test/${path}`, {
			method: "POST",
			headers: { Cookie: `dashcommerce_sid=${sessionId}` },
		}),
		input,
	} as unknown as RouteContext;
}

async function shippingLocation(input: Record<string, unknown>) {
	const { ctx } = makeRouteContext(settings);
	const sessionId = `sess_${Math.random()}`;
	await ctx.kv.set(`cart:${sessionId}`, ticketCart(sessionId));
	const res = (await sandbox.routes["cart/shipping-location"].handler(
		routeContext(ctx, "cart/shipping-location", sessionId, input),
		ctx,
	)) as Response;
	return { status: res.status, body: (await res.json()) as { cart?: CartState; error?: string } };
}

/** A cart with a physical item, a chosen shipping method and the given ship-to address. */
function shippedCart(sessionId: string, shippingAddress: Record<string, string>): CartState {
	const cart = ticketCart(sessionId) as unknown as Record<string, unknown>;
	const items = cart.items as Array<Record<string, unknown>>;
	return {
		...cart,
		items: items.map((line) => ({ ...line, isDigital: false })),
		shippingAddress,
		shippingMethod: { id: "flat", label: "Delivery", amount: { amount: 0, currency: "KES" } },
	} as unknown as CartState;
}

async function createSession(cart: CartState) {
	const { ctx } = makeRouteContext(settings);
	await ctx.kv.set(`cart:${cart.sessionId}`, cart);
	const res = (await sandbox.routes["checkout/create-session"].handler(
		routeContext(ctx, "checkout/create-session", cart.sessionId, {}),
		ctx,
	)) as Response;
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("cart/shipping-location", () => {
	it("accepts a country without a postcode", async () => {
		const res = await shippingLocation({ country: "ke" });
		expect(res.status).toBe(200);
		expect(res.body.cart?.shippingAddress?.country).toBe("KE");
		expect(res.body.cart?.shippingAddress?.postalCode).toBe("");
	});

	it("keeps a postcode when one is given", async () => {
		const res = await shippingLocation({ country: "GB", postalCode: " SW1A 1AA " });
		expect(res.status).toBe(200);
		expect(res.body.cart?.shippingAddress?.postalCode).toBe("SW1A 1AA");
	});

	it("still requires the country", async () => {
		const res = await shippingLocation({ postalCode: "00100" });
		expect(res.status).toBe(400);
		expect(res.body.error).toMatch(/country/);
	});
});

describe("checkout/create-session with a shipped cart", () => {
	const kenyanAddress = {
		firstName: "Wanjiru",
		lastName: "Kamau",
		line1: "Ngong Road",
		city: "Nairobi",
		region: "",
		postalCode: "",
		country: "KE",
	};

	it("starts a payment when the ship-to address has no postcode", async () => {
		registerPaymentProvider(createMockPaymentProvider());
		const res = await createSession(shippedCart(`sess_${Math.random()}`, kenyanAddress));
		expect(res.status).toBe(200);
		expect(String(res.body.error ?? "")).not.toMatch(/postal/i);
	});

	it("still refuses without a ship-to country", async () => {
		registerPaymentProvider(createMockPaymentProvider());
		const res = await createSession(
			shippedCart(`sess_${Math.random()}`, { ...kenyanAddress, country: "" }),
		);
		expect(res.status).toBe(409);
		expect(String(res.body.error)).toMatch(/country/i);
	});
});
