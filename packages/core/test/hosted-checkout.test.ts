import { describe, expect, it } from "bun:test";
import {
	extractErrorMessage,
	getHostedCheckoutCopy,
} from "../src/astro/hosted-checkout";

describe("Hosted Checkout presentation copy", () => {
	it("returns Stripe copy for stripe provider (physical cart)", () => {
		const copy = getHostedCheckoutCopy("stripe", false);
		expect(copy.label).toBe("Stripe");
		expect(copy.payButtonText).toBe("Pay with Stripe →");
		expect(copy.redirectingText).toBe("Redirecting to Stripe…");
		expect(copy.detailsHint).toContain("Stripe collects your full address on the next page");
		expect(copy.payHint).toContain("You'll be redirected to Stripe");
		expect(copy.payHint).toContain("We never see your card");
	});

	it("returns Stripe copy for stripe provider (digital cart)", () => {
		const copy = getHostedCheckoutCopy("stripe", true);
		expect(copy.label).toBe("Stripe");
		expect(copy.detailsHint).toContain("Stripe collects billing details on the next page");
		expect(copy.payHint).toContain("billing address and card details");
	});

	it("returns Paystack copy for paystack provider (physical cart) without mentioning Stripe", () => {
		const copy = getHostedCheckoutCopy("paystack", false);
		expect(copy.label).toBe("Paystack");
		expect(copy.payButtonText).toBe("Pay with Paystack →");
		expect(copy.redirectingText).toBe("Redirecting to Paystack…");
		expect(copy.detailsHint).toBe("Enter your email and location to view available shipping options.");
		expect(copy.detailsHint).not.toContain("Stripe");
		expect(copy.payHint).toContain("You'll be redirected to Paystack to complete your payment securely");
		expect(copy.payHint).not.toContain("Stripe");
	});

	it("returns Paystack copy for paystack provider (digital cart)", () => {
		const copy = getHostedCheckoutCopy("paystack", true);
		expect(copy.label).toBe("Paystack");
		expect(copy.detailsHint).toBe(
			"Enter your email address to receive your order receipt and digital access.",
		);
		expect(copy.detailsHint).not.toContain("Stripe");
		expect(copy.payHint).not.toContain("Stripe");
	});

	it("supports custom provider label override", () => {
		const copy = getHostedCheckoutCopy("paystack", false, "Paystack Payments");
		expect(copy.label).toBe("Paystack Payments");
		expect(copy.payButtonText).toBe("Pay with Paystack Payments →");
		expect(copy.redirectingText).toBe("Redirecting to Paystack Payments…");
	});
});

describe("Structured error parsing (extractErrorMessage)", () => {
	it("returns string body directly", () => {
		expect(extractErrorMessage("Invalid request parameter", 400)).toBe(
			"Invalid request parameter",
		);
	});

	it("extracts error when error is a string", () => {
		expect(
			extractErrorMessage({ error: "Customer email is required for Paystack checkout." }, 400),
		).toBe("Customer email is required for Paystack checkout.");
	});

	it("extracts message from structured error object { error: { message: '...' } }", () => {
		const structured = {
			success: false,
			error: {
				code: "INTERNAL_ERROR",
				message: "Plugin route error",
			},
		};
		const msg = extractErrorMessage(structured, 500);
		expect(msg).toBe("Plugin route error");
		expect(msg).not.toContain("[object Object]");
	});

	it("extracts top-level message if error property is absent", () => {
		expect(extractErrorMessage({ message: "Network connection lost" }, 503)).toBe(
			"Network connection lost",
		);
	});

	it("falls back to Payment setup failed (HTTP status) on empty or unrecognized shapes", () => {
		expect(extractErrorMessage({}, 500)).toBe("Payment setup failed (500)");
		expect(extractErrorMessage(null, 404)).toBe("Payment setup failed (404)");
		expect(extractErrorMessage(undefined, 502)).toBe("Payment setup failed (502)");
		expect(extractErrorMessage({ error: {} }, 400)).toBe("Payment setup failed (400)");
		expect(extractErrorMessage({ error: { message: "   " } }, 400)).toBe(
			"Payment setup failed (400)",
		);
	});

	it("never renders [object Object]", () => {
		const cases = [
			{ error: {} },
			{ error: { details: "bad" } },
			{ data: { nested: {} } },
			{ error: { message: {} } },
		];
		for (const c of cases) {
			const res = extractErrorMessage(c, 500);
			expect(res).not.toContain("[object Object]");
			expect(typeof res).toBe("string");
		}
	});
});

import { checkoutRoutes } from "../src/routes/checkout";
import type { CartState } from "../src/types";
import type { PluginContext, RouteContext } from "emdash";

describe("Stripe Hosted Checkout compatibility", () => {
	function makeStripeContext(fetchMock: (url: string, init?: RequestInit) => Promise<Response>) {
		const kv = new Map<string, unknown>([
			["settings:paymentProvider", "stripe"],
			["settings:stripeSecretKey", "sk_test_stripe_secret"],
			["settings:defaultCurrency", "USD"],
		]);
		const products = new Map([
			[
				"prod_digital",
				{
					id: "prod_digital",
					status: "published",
					data: {
						title: "Digital Ebook",
						type: "simple",
						prices: { USD: { amount: 2000 } },
						virtual: true,
						manage_stock: false,
					},
				},
			],
		]);
		const ctx = {
			kv: {
				async get<T>(k: string): Promise<T | null> {
					return (kv.get(k) as T) ?? null;
				},
				async set(k: string, v: unknown): Promise<void> {
					kv.set(k, v);
				},
				async delete(k: string): Promise<void> {
					kv.delete(k);
				},
			},
			storage: {},
			content: {
				async get(col: string, id: string) {
					if (col === "products") return products.get(id) ?? null;
					return null;
				},
			},
			http: { fetch: fetchMock },
			site: { url: "https://example.com" },
			log: { debug() {}, info() {}, warn() {}, error() {} },
		} as unknown as PluginContext;

		return { ctx, kv };
	}

	it("preserves Stripe hosted checkout without customer email (Stripe collects on redirect)", async () => {
		let capturedBody: string | undefined;
		const { ctx } = makeStripeContext(async (_url, init) => {
			capturedBody = String(init?.body);
			return new Response(
				JSON.stringify({
					id: "cs_stripe_no_email",
					url: "https://checkout.stripe.com/pay/cs_stripe_no_email",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const sessionId = "sess_stripe_no_email";
		const cart: CartState = {
			sessionId,
			currency: "USD",
			items: [
				{
					lineId: "line_d",
					productId: "prod_digital",
					quantity: 1,
					title: "Digital Ebook",
					isDigital: true,
					unitPrice: { amount: 2000, currency: "USD" },
					lineSubtotal: { amount: 2000, currency: "USD" },
				},
			],
			coupons: [],
			taxLines: [],
			subtotal: { amount: 2000, currency: "USD" },
			discountTotal: { amount: 0, currency: "USD" },
			shippingTotal: { amount: 0, currency: "USD" },
			taxTotal: { amount: 0, currency: "USD" },
			total: { amount: 2000, currency: "USD" },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		await ctx.kv.set(`cart:${sessionId}`, cart);

		const req = new Request("http://test/checkout/create-session", {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: `dashcommerce_sid=${sessionId}` },
			body: JSON.stringify({}),
		});
		const routeCtx = { ...ctx, request: req, input: {} } as unknown as RouteContext;

		const res = await checkoutRoutes["checkout/create-session"].handler(routeCtx, ctx);
		expect(res.status).toBe(200);
		const data = (await res.json()) as { url: string };
		expect(data.url).toBe("https://checkout.stripe.com/pay/cs_stripe_no_email");
		expect(capturedBody).not.toContain("customer_email");
	});

	it("passes known customer email to Stripe when provided", async () => {
		let capturedBody: string | undefined;
		const { ctx } = makeStripeContext(async (_url, init) => {
			capturedBody = String(init?.body);
			return new Response(
				JSON.stringify({
					id: "cs_stripe_with_email",
					url: "https://checkout.stripe.com/pay/cs_stripe_with_email",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		});

		const sessionId = "sess_stripe_with_email";
		const cart: CartState = {
			sessionId,
			currency: "USD",
			items: [
				{
					lineId: "line_d",
					productId: "prod_digital",
					quantity: 1,
					title: "Digital Ebook",
					isDigital: true,
					unitPrice: { amount: 2000, currency: "USD" },
					lineSubtotal: { amount: 2000, currency: "USD" },
				},
			],
			coupons: [],
			taxLines: [],
			subtotal: { amount: 2000, currency: "USD" },
			discountTotal: { amount: 0, currency: "USD" },
			shippingTotal: { amount: 0, currency: "USD" },
			taxTotal: { amount: 0, currency: "USD" },
			total: { amount: 2000, currency: "USD" },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		await ctx.kv.set(`cart:${sessionId}`, cart);

		const req = new Request("http://test/checkout/create-session", {
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: `dashcommerce_sid=${sessionId}` },
			body: JSON.stringify({ customerEmail: "ada@example.com" }),
		});
		const routeCtx = {
			...ctx,
			request: req,
			input: { customerEmail: "ada@example.com" },
		} as unknown as RouteContext;

		const res = await checkoutRoutes["checkout/create-session"].handler(routeCtx, ctx);
		expect(res.status).toBe(200);
		const data = (await res.json()) as { url: string };
		expect(data.url).toBe("https://checkout.stripe.com/pay/cs_stripe_with_email");
		expect(capturedBody).toContain("customer_email=ada%40example.com");
	});
});
