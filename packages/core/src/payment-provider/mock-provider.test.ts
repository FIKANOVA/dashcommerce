// mock-provider.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockPaymentProvider } from "./mock-provider";
import type { PaymentProviderCredentials, PaymentProviderRuntimeContext } from "./types";

const ctx: PaymentProviderRuntimeContext = {
	http: { fetch },
	log: { info: () => {}, warn: () => {}, error: () => {} },
};

const creds: PaymentProviderCredentials = { secretKey: "sk_test_mock" };

test("mock: initCheckout succeeds by default, separates references, and formats clean redirect URLs", async () => {
	const provider = createMockPaymentProvider();

	// Test 1: URL with no query string
	const res1 = await provider.initCheckout(
		ctx,
		{
			orderDraftId: "d1",
			amount: 1000,
			currency: "KES",
			customer: { email: "x@example.com" },
			lineItems: [{ name: "Jersey", amount: 1000, currency: "KES", quantity: 1 }],
			successUrl: "https://example.com/thank-you",
			cancelUrl: "https://example.com/checkout",
		},
		creds,
	);
	assert.equal(res1.kind, "redirect");
	if (res1.kind === "redirect") {
		assert.equal(res1.checkoutReference, "mock_ref_d1");
		assert.equal(res1.providerReference, "mock_ref_d1");
		assert.equal(res1.redirectUrl, "https://example.com/thank-you?mock=1");
	}

	// Test 2: URL with existing query params
	const res2 = await provider.initCheckout(
		ctx,
		{
			orderDraftId: "d2",
			amount: 1000,
			currency: "KES",
			customer: { email: "x@example.com" },
			lineItems: [],
			successUrl: "https://example.com/thank-you?existing=val&num=1",
			cancelUrl: "https://example.com/checkout",
		},
		creds,
	);
	if (res2.kind === "redirect") {
		assert.equal(
			res2.redirectUrl,
			"https://example.com/thank-you?existing=val&num=1&mock=1",
		);
	}

	// Test 3: URL with fragment/hash
	const res3 = await provider.initCheckout(
		ctx,
		{
			orderDraftId: "d3",
			amount: 1000,
			currency: "KES",
			customer: { email: "x@example.com" },
			lineItems: [],
			successUrl: "https://example.com/thank-you#step2",
			cancelUrl: "https://example.com/checkout",
		},
		creds,
	);
	if (res3.kind === "redirect") {
		assert.equal(res3.redirectUrl, "https://example.com/thank-you?mock=1#step2");
	}
});

test("mock: initCheckout supports async pending mode", async () => {
	const provider = createMockPaymentProvider({ asyncPendingCheckout: true });
	const res = await provider.initCheckout(
		ctx,
		{
			orderDraftId: "d_async",
			amount: 2500,
			currency: "KES",
			customer: { email: "pending@example.com" },
			lineItems: [],
			successUrl: "https://example.com/thank-you",
			cancelUrl: "https://example.com/checkout",
		},
		creds,
	);
	assert.equal(res.kind, "pending");
	if (res.kind === "pending") {
		assert.equal(res.checkoutReference, "mock_ref_d_async");
		assert.equal(res.status, "pending");
	}
});

test("mock: initCheckout can be forced to fail for negative-path tests", async () => {
	const provider = createMockPaymentProvider({ failInit: true });
	await assert.rejects(() =>
		provider.initCheckout(
			ctx,
			{
				orderDraftId: "d2",
				amount: 1000,
				currency: "KES",
				customer: { email: "x@example.com" },
				lineItems: [],
				successUrl: "https://example.com/thank-you",
				cancelUrl: "https://example.com/checkout",
			},
			creds,
		),
	);
});

test("mock: supportsCurrency checks currency support with case-insensitivity", () => {
	const provider = createMockPaymentProvider();
	assert.equal(provider.supportsCurrency("KES"), true);
	assert.equal(provider.supportsCurrency("kes"), true);
	assert.equal(provider.supportsCurrency(" USD "), true);
	assert.equal(provider.supportsCurrency("EUR"), false);
	assert.equal(provider.supportsCurrency("GBP"), false);
	assert.equal(provider.supportsCurrency(""), false);
});

test("mock: verifyWebhook only accepts the fixture 'test-secret'", async () => {
	const provider = createMockPaymentProvider();
	const ok = await provider.verifyWebhook({
		rawBody: "{}",
		signatureHeader: "x",
		secret: "test-secret",
	});
	assert.equal(ok.ok, true);
	const bad = await provider.verifyWebhook({
		rawBody: "{}",
		signatureHeader: "x",
		secret: "wrong",
	});
	assert.equal(bad.ok, false);
});

test("mock: parseWebhookEvent handles unparseable JSON without throwing", () => {
	const provider = createMockPaymentProvider();
	const event = provider.parseWebhookEvent("invalid json {{{");
	assert.equal(event.type, "unhandled");
	if (event.type === "unhandled") {
		assert.equal(event.providerEventType, "unparseable");
	}
});

test("mock: parseWebhookEvent round-trips charge.succeeded with event identity and separated references", () => {
	const provider = createMockPaymentProvider();

	// Case 1: Native event ID present
	const event1 = provider.parseWebhookEvent(
		JSON.stringify({
			id: "evt_mock_123",
			type: "charge.succeeded",
			orderDraftId: "d3",
			checkoutReference: "cs_mock_d3",
			paymentReference: "pi_mock_d3",
			amount: 500,
			currency: "KES",
			email: "y@example.com",
		}),
	);
	assert.equal(event1.type, "charge.succeeded");
	if (event1.type === "charge.succeeded") {
		assert.equal(event1.providerId, "mock");
		assert.equal(event1.providerEventId, "evt_mock_123");
		assert.equal(event1.eventIdSource, "native");
		assert.equal(event1.checkoutReference, "cs_mock_d3");
		assert.equal(event1.paymentReference, "pi_mock_d3");
		assert.equal(event1.orderDraftId, "d3");
		assert.equal(event1.amount, 500);
	}

	// Case 2: Missing event ID derives a deterministic key
	const event2 = provider.parseWebhookEvent(
		JSON.stringify({
			type: "charge.succeeded",
			orderDraftId: "d4",
			paymentReference: "pi_mock_d4",
			amount: 1000,
		}),
	);
	assert.equal(event2.type, "charge.succeeded");
	if (event2.type === "charge.succeeded") {
		assert.equal(event2.providerEventId, "mock:charge.succeeded:d4");
		assert.equal(event2.eventIdSource, "derived");
		assert.equal(event2.paymentReference, "pi_mock_d4");
	}
});

test("mock: parseWebhookEvent handles charge.failed", () => {
	const provider = createMockPaymentProvider();
	const event = provider.parseWebhookEvent(
		JSON.stringify({
			id: "evt_fail_1",
			type: "charge.failed",
			orderDraftId: "d_fail",
			paymentReference: "pi_mock_fail",
		}),
	);
	assert.equal(event.type, "charge.failed");
	if (event.type === "charge.failed") {
		assert.equal(event.providerEventId, "evt_fail_1");
		assert.equal(event.orderDraftId, "d_fail");
		assert.equal(event.paymentReference, "pi_mock_fail");
	}
});

test("mock: refund enforces refundRequestId and supports forced failure", async () => {
	const provider = createMockPaymentProvider();
	const refund = await provider.refund(
		ctx,
		{
			paymentReference: "pi_captured_123",
			refundRequestId: "req_rf_001",
			currency: "KES",
			amount: 500,
		},
		creds,
	);
	assert.equal(refund.status, "succeeded");
	assert.equal(refund.refundRequestId, "req_rf_001");
	assert.equal(refund.providerRefundId, "mock_refund_req_rf_001_pi_captured_123");
	assert.equal(refund.amount, 500);

	const failing = createMockPaymentProvider({ failRefund: true });
	await assert.rejects(() =>
		failing.refund(
			ctx,
			{
				paymentReference: "pi_captured_123",
				refundRequestId: "req_rf_002",
				currency: "KES",
			},
			creds,
		),
	);
});

test("mock: formatAmount formats minor units into major units", () => {
	const provider = createMockPaymentProvider();
	assert.equal(provider.formatAmount({ amount: 250000, currency: "KES" }), "KES 2500.00");
	assert.equal(provider.formatAmount({ amount: 1050, currency: "usd" }), "USD 10.50");
});
