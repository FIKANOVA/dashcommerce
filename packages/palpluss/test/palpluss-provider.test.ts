import { describe, expect, it } from "bun:test";
import { PalplussPaymentProvider } from "../src/provider";
import type { PalplussCredentials } from "../src/types";

describe("PalplussPaymentProvider", () => {
	const provider = new PalplussPaymentProvider();

	const testCredentials: PalplussCredentials = {
		apiKey: "test_palpluss_api_key",
		channelId: "123456",
		callbackUrl: "https://example.com/api/checkout/webhook",
	};

	it("supportsCurrency: only supports KES", () => {
		expect(provider.supportsCurrency("KES")).toBe(true);
		expect(provider.supportsCurrency("kes")).toBe(true);
		expect(provider.supportsCurrency(" USD ")).toBe(false);
		expect(provider.supportsCurrency("EUR")).toBe(false);
		expect(provider.supportsCurrency("NGN")).toBe(false);
		expect(provider.supportsCurrency(null as any)).toBe(false);
	});

	it("formatAmount: renders KES major units with proper decimals", () => {
		expect(provider.formatAmount({ amount: 100000, currency: "KES" })).toBe(
			"KES 1,000.00",
		);
		expect(provider.formatAmount({ amount: 25050, currency: "KES" })).toBe(
			"KES 250.50",
		);
	});

	it("initCheckout: validates currency and customer phone", async () => {
		const ctx = {
			http: {
				fetch: async () => new Response("{}", { status: 200 }),
			},
			log: { info() {}, warn() {}, error() {} },
		};

		// Non-KES currency throws
		await expect(
			provider.initCheckout(
				ctx as any,
				{
					orderDraftId: "draft_123",
					amount: 50000,
					currency: "USD",
					customer: { email: "test@example.com", phone: "0712345678" },
					lineItems: [],
				},
				testCredentials,
			),
		).rejects.toThrow("PalPluss STK only supports KES");

		// Missing customer phone throws
		await expect(
			provider.initCheckout(
				ctx as any,
				{
					orderDraftId: "draft_123",
					amount: 50000,
					currency: "KES",
					customer: { email: "test@example.com" },
					lineItems: [],
				},
				testCredentials,
			),
		).rejects.toThrow("PalPluss STK requires a customer phone number");

		// Invalid phone throws
		await expect(
			provider.initCheckout(
				ctx as any,
				{
					orderDraftId: "draft_123",
					amount: 50000,
					currency: "KES",
					customer: { email: "test@example.com", phone: "12345" },
					lineItems: [],
				},
				testCredentials,
			),
		).rejects.toThrow("Invalid Kenyan phone number");
	});

	it("initCheckout: enforces length constraints (accountReference <= 12, description <= 13)", async () => {
		let capturedBody: any;
		let capturedAuth: string | null = null;

		const ctx = {
			http: {
				fetch: async (_url: any, init: any) => {
					capturedBody = JSON.parse(init.body);
					capturedAuth = init.headers.Authorization;
					return new Response(
						JSON.stringify({
							status: "PENDING",
							transactionId: "TXN_PALPLUSS_777",
						}),
						{ status: 200 },
					);
				},
			},
			log: { info() {}, warn() {}, error() {} },
		};

		const result = await provider.initCheckout(
			ctx as any,
			{
				orderDraftId: "very_long_draft_identifier_exceeding_twelve_chars",
				amount: 150000, // 1500 KES
				currency: "KES",
				customer: { email: "test@example.com", phone: "+254712345678" },
				lineItems: [],
			},
			testCredentials,
		);

		expect(result.kind).toBe("pending");
		expect(result.status).toBe("pending");
		expect(result.checkoutReference).toBe("TXN_PALPLUSS_777");

		expect(capturedBody.phoneNumber).toBe("254712345678");
		expect(capturedBody.amount).toBe(1500);
		expect(capturedBody.accountReference.length).toBeLessThanOrEqual(12);
		expect(capturedBody.description.length).toBeLessThanOrEqual(13);
		expect(capturedBody.channelId).toBe("123456");
		expect(capturedBody.callbackUrl).toBe(
			"https://example.com/api/checkout/webhook",
		);

		// Basic auth default
		expect(capturedAuth).toBe("Bearer test_palpluss_api_key");
	});

	it("verifyWebhook: returns hint rejection for unsigned callbacks", async () => {
		const res = await provider.verifyWebhook({
			rawBody: JSON.stringify({ status: "SUCCESS" }),
			signatureHeader: null,
		});

		expect(res.ok).toBe(false);
		expect(res.reason).toContain(
			"unsigned_reconciliation_hint_requires_server_lookup",
		);
	});

	it("parseWebhookEvent: maps SUCCESS to charge.succeeded with separated references and derived event ID", () => {
		const raw = JSON.stringify({
			status: "SUCCESS",
			transactionId: "TXN_001",
			amount: 500, // KES 500
			accountReference: "DRAFT_999",
			channelId: "123456",
			mpesaReceipt: "QK12345678",
			email: "buyer@nondies.co.ke",
		});

		const event = provider.parseWebhookEvent(raw);
		expect(event.type).toBe("charge.succeeded");
		expect(event.providerId).toBe("palpluss");
		expect(event.amount).toBe(50000); // minor units
		expect(event.currency).toBe("KES");
		expect(event.paymentReference).toBe("QK12345678"); // M-Pesa receipt
		expect(event.checkoutReference).toBe("TXN_001");
		expect(event.orderDraftId).toBe("DRAFT_999");
		expect(event.eventIdSource).toBe("derived");
		expect(event.providerEventId).toBe("palpluss:123456:TXN_001:SUCCESS");
		expect(event.customer.email).toBe("buyer@nondies.co.ke");
	});

	it("parseWebhookEvent: maps FAILED and EXPIRED to charge.failed", () => {
		const rawFailed = JSON.stringify({
			status: "FAILED",
			transactionId: "TXN_002",
			failureReason: "User cancelled STK prompt",
			accountReference: "DRAFT_888",
		});

		const failedEvent = provider.parseWebhookEvent(rawFailed);
		expect(failedEvent.type).toBe("charge.failed");
		expect(failedEvent.reason).toBe("User cancelled STK prompt");

		const rawExpired = JSON.stringify({
			status: "EXPIRED",
			transactionId: "TXN_003",
			accountReference: "DRAFT_777",
		});

		const expiredEvent = provider.parseWebhookEvent(rawExpired);
		expect(expiredEvent.type).toBe("charge.failed");
		expect(expiredEvent.reason).toBe("expired");
	});

	it("parseWebhookEvent: handles unparseable JSON without throwing", () => {
		const event = provider.parseWebhookEvent("invalid-json{");
		expect(event.type).toBe("unhandled");
		expect(event.providerEventType).toBe("unparseable");
	});

	it("getPaymentStatus: performs server lookup and maps status", async () => {
		const ctx = {
			http: {
				fetch: async () =>
					new Response(
						JSON.stringify({
							status: "SUCCESS",
							transactionId: "TXN_OK",
							amount: 750,
							mpesaReceipt: "NL12345678",
						}),
						{ status: 200 },
					),
			},
			log: { info() {}, warn() {}, error() {} },
		};

		const status = await provider.getPaymentStatus!(
			ctx as any,
			"TXN_OK",
			testCredentials,
		);

		expect(status.status).toBe("succeeded");
		expect(status.paymentReference).toBe("NL12345678");
		expect(status.amount).toBe(75000);
		expect(status.currency).toBe("KES");
	});

	it("refund: enforces manual reversal requirement and requires refundRequestId", async () => {
		const ctx = {
			http: { fetch: async () => new Response() },
			log: { info() {}, warn() {}, error() {} },
		} as any;

		await expect(
			provider.refund(
				ctx,
				{
					paymentReference: "NL12345678",
					amount: 50000,
					currency: "KES",
					refundRequestId: "",
				},
				testCredentials,
			),
		).rejects.toThrow("refundRequestId is required");

		const res = await provider.refund(
			ctx,
			{
				paymentReference: "NL12345678",
				amount: 50000,
				currency: "KES",
				refundRequestId: "ref_req_001",
			},
			testCredentials,
		);

		expect(res.status).toBe("failed");
		expect(res.providerRefundId).toBe("manual_reversal_required");
	});
});
