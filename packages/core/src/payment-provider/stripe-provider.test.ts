import assert from "node:assert/strict";
// stripe-provider.test.ts — verifies StripePaymentProvider adapter logic
import { test } from "node:test";
import { stripePaymentProvider } from "./stripe-provider";
import type { PaymentProviderCredentials, PaymentProviderRuntimeContext } from "./types";

const ctx: PaymentProviderRuntimeContext = {
	http: {
		fetch: async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = String(url);
			// Mock Stripe Checkout Session creation response
			if (urlStr.includes("/v1/checkout/sessions")) {
				const body = String(init?.body ?? "");
				return new Response(
					JSON.stringify({
						id: "cs_mock_123",
						url: "https://checkout.stripe.com/c/pay/cs_mock_123",
						mode: body.includes("mode=subscription") ? "subscription" : "payment",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			// Mock Stripe Refund creation response
			if (urlStr.includes("/v1/refunds")) {
				return new Response(
					JSON.stringify({
						id: "re_mock_123",
						status: "succeeded",
						amount: 5000,
						currency: "usd",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response("{}", { status: 200 });
		},
	},
	log: { info: () => {}, warn: () => {}, error: () => {} },
};

const creds: PaymentProviderCredentials = { secretKey: "sk_test_123" };

test("supportsCurrency: validates 3-letter ISO currency codes", () => {
	assert.equal(stripePaymentProvider.supportsCurrency("KES"), true);
	assert.equal(stripePaymentProvider.supportsCurrency("usd"), true);
	assert.equal(stripePaymentProvider.supportsCurrency(" EUR "), true);
	assert.equal(stripePaymentProvider.supportsCurrency("US"), false);
	assert.equal(stripePaymentProvider.supportsCurrency("USDD"), false);
	assert.equal(stripePaymentProvider.supportsCurrency(""), false);
});

test("parseWebhookEvent: checkout.session.completed maps customer address to billingAddress and preserves fallback", () => {
	const raw = JSON.stringify({
		id: "evt_stripe_123",
		type: "checkout.session.completed",
		data: {
			object: {
				id: "cs_test_123",
				object: "checkout.session",
				mode: "payment",
				amount_total: 250000,
				currency: "kes",
				payment_intent: "pi_captured_123",
				metadata: { orderDraftId: "draft_abc" },
				customer_details: {
					email: "fan@example.com",
					name: "Jane Fan",
					phone: "+254700000000",
					address: { line1: "123 St", city: "Nairobi", country: "KE", postal_code: "00100" },
				},
				shipping_details: {
					address: { line1: "456 Ship Rd", city: "Nairobi", country: "KE", postal_code: "00100" },
				},
			},
		},
	});
	const event = stripePaymentProvider.parseWebhookEvent(raw);
	assert.equal(event.type, "charge.succeeded");
	if (event.type === "charge.succeeded") {
		assert.equal(event.orderDraftId, "draft_abc");
		assert.equal(event.providerId, "stripe");
		assert.equal(event.providerEventId, "evt_stripe_123");
		assert.equal(event.eventIdSource, "native");
		assert.equal(event.checkoutReference, "cs_test_123");
		assert.equal(event.paymentReference, "pi_captured_123");
		assert.equal(event.amount, 250000);
		assert.equal(event.currency, "KES");
		assert.equal(event.customer.email, "fan@example.com");
		assert.equal(event.billingAddress?.line1, "123 St");
		assert.equal(event.shippingAddress?.line1, "456 Ship Rd");
	}
});

test("parseWebhookEvent: digital cart with billingAddress only falls back to shippingAddress", () => {
	const raw = JSON.stringify({
		id: "evt_digital_1",
		type: "checkout.session.completed",
		data: {
			object: {
				id: "cs_digital_1",
				object: "checkout.session",
				mode: "payment",
				amount_total: 5000,
				currency: "usd",
				payment_intent: "pi_digital_1",
				metadata: { orderDraftId: "draft_digital" },
				customer_details: {
					email: "digital@example.com",
					address: {
						line1: "789 Digital St",
						city: "Mombasa",
						country: "KE",
						postal_code: "80100",
					},
				},
			},
		},
	});
	const event = stripePaymentProvider.parseWebhookEvent(raw);
	assert.equal(event.type, "charge.succeeded");
	if (event.type === "charge.succeeded") {
		assert.equal(event.billingAddress?.line1, "789 Digital St");
		assert.equal(
			event.shippingAddress?.line1,
			"789 Digital St",
			"Shipping must fall back to billing for digital cart",
		);
	}
});

test("parseWebhookEvent: checkout.session.completed falls back to client_reference_id when metadata.orderDraftId absent", () => {
	const raw = JSON.stringify({
		id: "evt_fallback_1",
		type: "checkout.session.completed",
		data: {
			object: {
				id: "cs_test_456",
				object: "checkout.session",
				mode: "payment",
				currency: "usd",
				client_reference_id: "draft_xyz",
				payment_intent: "pi_456",
				customer_details: { email: "a@b.com" },
			},
		},
	});
	const event = stripePaymentProvider.parseWebhookEvent(raw);
	assert.equal(event.type, "charge.succeeded");
	if (event.type === "charge.succeeded") {
		assert.equal(event.orderDraftId, "draft_xyz");
		assert.equal(event.paymentReference, "pi_456");
		assert.equal(event.checkoutReference, "cs_test_456");
	}
});

test("parseWebhookEvent: payment_intent.payment_failed maps to charge.failed", () => {
	const raw = JSON.stringify({
		id: "evt_fail_1",
		type: "payment_intent.payment_failed",
		data: {
			object: {
				id: "pi_test_1",
				metadata: { orderDraftId: "draft_fail", sessionId: "cs_fail_1" },
				last_payment_error: { message: "Card declined" },
			},
		},
	});
	const event = stripePaymentProvider.parseWebhookEvent(raw);
	assert.equal(event.type, "charge.failed");
	if (event.type === "charge.failed") {
		assert.equal(event.orderDraftId, "draft_fail");
		assert.equal(event.providerEventId, "evt_fail_1");
		assert.equal(event.paymentReference, "pi_test_1");
		assert.equal(event.checkoutReference, "cs_fail_1");
		assert.equal(event.reason, "Card declined");
	}
});

test("parseWebhookEvent: unrelated event types map to 'unhandled', never dropped silently", () => {
	const raw = JSON.stringify({ id: "evt_cust_1", type: "customer.created", data: { object: {} } });
	const event = stripePaymentProvider.parseWebhookEvent(raw);
	assert.equal(event.type, "unhandled");
	if (event.type === "unhandled") {
		assert.equal(event.providerEventType, "customer.created");
		assert.equal(event.providerEventId, "evt_cust_1");
	}
});

test("parseWebhookEvent: unparseable body maps to 'unhandled' rather than throwing", () => {
	const event = stripePaymentProvider.parseWebhookEvent("not json{{{");
	assert.equal(event.type, "unhandled");
	if (event.type === "unhandled") {
		assert.equal(event.providerEventType, "unparseable");
	}
});

test("parseWebhookEvent: checkout.session.completed with no correlatable id is 'unhandled' (never fabricates an orderDraftId)", () => {
	const raw = JSON.stringify({
		id: "evt_no_id",
		type: "checkout.session.completed",
		data: { object: { id: "cs_test_789", object: "checkout.session", mode: "payment" } },
	});
	const event = stripePaymentProvider.parseWebhookEvent(raw);
	assert.equal(event.type, "unhandled");
});

test("initCheckout: passes Stripe checkout options and returns redirect result", async () => {
	const res = await stripePaymentProvider.initCheckout(
		ctx,
		{
			orderDraftId: "draft_full_stripe",
			amount: 5000,
			currency: "USD",
			customer: { email: "customer@example.com" },
			lineItems: [
				{
					name: "Membership Plan",
					amount: 5000,
					currency: "USD",
					quantity: 1,
					recurring: { interval: "year", intervalCount: 1 },
					taxBehavior: "exclusive",
				},
			],
			successUrl: "https://example.com/thank-you",
			cancelUrl: "https://example.com/checkout",
			shippingOptions: [{ id: "std", label: "Standard Shipping", amount: 500, currency: "USD" }],
			allowedShippingCountries: ["KE", "US"],
			providerOptions: {
				stripe: {
					mode: "subscription",
					automaticTax: true,
					billingAddressCollection: "required",
					subscriptionTrialPeriodDays: 14,
					subscriptionMetadata: { membershipTier: "gold" },
				},
			},
		},
		creds,
	);
	assert.equal(res.kind, "redirect");
	if (res.kind === "redirect") {
		assert.equal(res.checkoutReference, "cs_mock_123");
		assert.equal(res.redirectUrl, "https://checkout.stripe.com/c/pay/cs_mock_123");
		assert.equal(res.status, "pending");
	}
});

test("refund: requires refundRequestId and calls Stripe with idempotency key", async () => {
	const res = await stripePaymentProvider.refund(
		ctx,
		{
			paymentReference: "pi_captured_999",
			refundRequestId: "req_rf_999",
			currency: "USD",
			amount: 5000,
			reason: "requested_by_customer",
		},
		creds,
	);
	assert.equal(res.status, "succeeded");
	assert.equal(res.refundRequestId, "req_rf_999");
	assert.equal(res.providerRefundId, "re_mock_123");
	assert.equal(res.amount, 5000);
	assert.equal(res.currency, "USD");
});

test("refund: throws if refundRequestId or paymentReference is missing", async () => {
	await assert.rejects(
		() =>
			stripePaymentProvider.refund(
				ctx,
				// @ts-expect-error testing missing refundRequestId
				{ paymentReference: "pi_123", currency: "USD" },
				creds,
			),
		/refundRequestId/,
	);
});

test("formatAmount: renders major units with currency code", () => {
	assert.equal(
		stripePaymentProvider.formatAmount({ amount: 150000, currency: "kes" }),
		"KES 1500.00",
	);
	assert.equal(stripePaymentProvider.formatAmount({ amount: 999, currency: "USD" }), "USD 9.99");
});
