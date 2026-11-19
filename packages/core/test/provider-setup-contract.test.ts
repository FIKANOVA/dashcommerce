/**
 * FIK-59 slice 1: what a provider declares for setup and on-page checkout.
 */

import { describe, expect, it } from "bun:test";
import {
	createMockPaymentProvider,
	type PaymentProviderRuntimeContext,
	providerCheckoutStyles,
	stripePaymentProvider,
} from "../src/payment-provider";

function ctxWith(fetch: (url: string, init?: RequestInit) => Promise<Response>) {
	return {
		http: { fetch },
		log: { info() {}, warn() {}, error() {} },
	} as PaymentProviderRuntimeContext;
}

describe("checkout styles", () => {
	it("defaults to hosted only when a provider declares nothing", () => {
		expect(providerCheckoutStyles(createMockPaymentProvider())).toEqual(["hosted"]);
	});

	it("Stripe offers hosted and on-page (Elements)", () => {
		expect(providerCheckoutStyles(stripePaymentProvider)).toEqual(["hosted", "on_page"]);
	});

	it("the mock provider can declare on-page and returns an on_page result", async () => {
		const mock = createMockPaymentProvider({ onPageCheckout: true });
		expect(providerCheckoutStyles(mock)).toEqual(["hosted", "on_page"]);
		const result = await mock.initCheckout(
			ctxWith(async () => new Response()),
			{
				orderDraftId: "d1",
				amount: 100,
				currency: "KES",
				customer: { email: "a@example.com" },
				lineItems: [],
				successUrl: "https://shop.example/thank-you/d1",
				cancelUrl: "https://shop.example/checkout",
				checkoutStyle: "on_page",
			},
			{ secretKey: "x" },
		);
		expect(result).toEqual({
			kind: "on_page",
			checkoutReference: "mock_ref_d1",
			client: { reference: "mock_ref_d1" },
		});
	});
});

describe("Stripe checkConnection", () => {
	it("reports the account when Stripe accepts the key", async () => {
		let called = "";
		const result = await stripePaymentProvider.checkConnection?.(
			ctxWith(async (url) => {
				called = url;
				return new Response(JSON.stringify({ id: "acct_123", charges_enabled: true }), {
					status: 200,
				});
			}),
			{ secretKey: "sk_test_1234567890abcdef" },
		);
		expect(called).toBe("https://api.stripe.com/v1/account");
		expect(result?.ok).toBe(true);
		expect(result?.detail).toContain("acct_123");
	});

	it("reports Stripe's error when the key is refused", async () => {
		const result = await stripePaymentProvider.checkConnection?.(
			ctxWith(
				async () =>
					new Response(JSON.stringify({ error: { message: "Invalid API Key provided" } }), {
						status: 401,
					}),
			),
			{ secretKey: "sk_test_wrong" },
		);
		expect(result?.ok).toBe(false);
		expect(result?.detail).toContain("Invalid API Key");
	});
});

describe("descriptions", () => {
	it("Stripe describes itself for the setup screen", () => {
		expect(stripePaymentProvider.description).toMatch(/card/i);
	});
});
