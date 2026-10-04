import { describe, expect, it } from "bun:test";
import { clearTokenCache } from "../src/client";
import { PesapalPaymentProvider } from "../src/provider";

const credentials = {
	apiKey: "test_consumer_key",
	secretKey: "test_consumer_secret",
	channelId: "test_ipn_id_12345",
};

describe("PesapalPaymentProvider", () => {
	it("supportsCurrency validates East African and international currencies", () => {
		const provider = new PesapalPaymentProvider();
		expect(provider.supportsCurrency("KES")).toBe(true);
		expect(provider.supportsCurrency("kes")).toBe(true);
		expect(provider.supportsCurrency("UGX")).toBe(true);
		expect(provider.supportsCurrency("TZS")).toBe(true);
		expect(provider.supportsCurrency("USD")).toBe(true);
		expect(provider.supportsCurrency("XYZ")).toBe(false);
	});

	it("formatAmount formats minor units correctly", () => {
		const provider = new PesapalPaymentProvider();
		expect(provider.formatAmount({ amount: 250000, currency: "KES" })).toContain("2,500.00");
	});

	it("initCheckout acquires token and submits order returning redirect URL", async () => {
		clearTokenCache();
		const provider = new PesapalPaymentProvider();

		const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
			const urlStr = url.toString();
			if (urlStr.includes("/api/Auth/RequestToken")) {
				return new Response(
					JSON.stringify({
						token: "jwt_token_sample_abc123",
						expiryDate: new Date(Date.now() + 300000).toISOString(),
						status: "200",
						message: "Token generated",
					}),
					{ status: 200 },
				);
			}
			if (urlStr.includes("/api/Transactions/SubmitOrder")) {
				const body = JSON.parse(init?.body as string);
				expect(body.id).toBe("chk_pesapal_1001");
				expect(body.currency).toBe("KES");
				expect(body.amount).toBe(2500); // 250000 minor -> 2500 major
				expect(body.notification_id).toBe("test_ipn_id_12345");
				return new Response(
					JSON.stringify({
						order_tracking_id: "pesapal_track_9999",
						merchant_reference: "chk_pesapal_1001",
						redirect_url: "https://cybqa.pesapal.com/pesapalv3/checkout?id=track_9999",
						error: null,
						status: "200",
					}),
					{ status: 200 },
				);
			}
			return new Response("Not Found", { status: 404 });
		};

		const ctx = {
			http: { fetch: mockFetch as unknown as typeof fetch },
			log: { info: () => {}, warn: () => {}, error: () => {} },
		};

		const result = await provider.initCheckout(
			ctx,
			{
				orderDraftId: "chk_pesapal_1001",
				amount: 250000,
				currency: "KES",
				successUrl: "https://example.com/checkout/return",
				cancelUrl: "https://example.com/checkout/cancel",
				customer: { email: "fan@nondies.co.ke", name: "Humphrey Kayange" },
				lineItems: [],
			},
			credentials,
		);

		expect(result.kind).toBe("redirect");
		expect(result.checkoutReference).toBe("chk_pesapal_1001");
		expect(result.providerReference).toBe("pesapal_track_9999");
		expect(result.redirectUrl).toBe("https://cybqa.pesapal.com/pesapalv3/checkout?id=track_9999");
	});

	it("verifyWebhook returns ok: true when OrderTrackingId is present", async () => {
		const provider = new PesapalPaymentProvider();
		const result = await provider.verifyWebhook({
			rawBody: JSON.stringify({
				OrderTrackingId: "pesapal_track_9999",
				OrderMerchantReference: "chk_pesapal_1001",
				OrderNotificationType: "IPNCHANGE",
			}),
			signatureHeader: "",
			secret: "",
		});

		expect(result.ok).toBe(true);
	});

	it("parseWebhookEvent normalizes completed payment IPN payload", () => {
		const provider = new PesapalPaymentProvider();

		const event = provider.parseWebhookEvent(
			JSON.stringify({
				OrderTrackingId: "pesapal_track_9999",
				OrderMerchantReference: "chk_pesapal_1001",
				PaymentStatus: "COMPLETED",
				ConfirmationCode: "QWE789RTY",
				Amount: 2500,
				Currency: "KES",
				Email: "fan@nondies.co.ke",
				PaymentMethod: "MPESA",
			}),
		);

		expect(event.type).toBe("charge.succeeded");
		if (event.type === "charge.succeeded") {
			expect(event.providerId).toBe("pesapal");
			expect(event.orderDraftId).toBe("chk_pesapal_1001");
			expect(event.paymentReference).toBe("pesapal_track_9999");
			expect(event.amount).toBe(250000);
			expect(event.currency).toBe("KES");
			expect(event.providerEventId).toBe("QWE789RTY");
			expect(event.eventIdSource).toBe("native");
			expect(event.channel).toBe("MPESA");
		}
	});

	it("getPaymentStatus fetches and maps status cleanly", async () => {
		clearTokenCache();
		const provider = new PesapalPaymentProvider();

		const mockFetch = async (url: string | URL | Request) => {
			const urlStr = url.toString();
			if (urlStr.includes("/api/Auth/RequestToken")) {
				return new Response(
					JSON.stringify({
						token: "jwt_token_sample_abc123",
						expiryDate: new Date(Date.now() + 300000).toISOString(),
						status: "200",
					}),
					{ status: 200 },
				);
			}
			if (urlStr.includes("/api/Transactions/GetTransactionStatus")) {
				return new Response(
					JSON.stringify({
						payment_method: "VISA",
						amount: 5000,
						currency: "KES",
						confirmation_code: "AUTH_CARD_444",
						order_tracking_id: "pesapal_track_8888",
						payment_status_description: "Completed",
						status_code: 1,
						merchant_reference: "chk_pesapal_1002",
						status: "200",
					}),
					{ status: 200 },
				);
			}
			return new Response("Not Found", { status: 404 });
		};

		const ctx = {
			http: { fetch: mockFetch as unknown as typeof fetch },
			log: { info: () => {}, warn: () => {}, error: () => {} },
		};

		const pollRes = await provider.getPaymentStatus(
			ctx,
			"pesapal_track_8888",
			credentials,
		);

		expect(pollRes.status).toBe("succeeded");
		expect(pollRes.paymentReference).toBe("pesapal_track_8888");
		expect(pollRes.amount).toBe(500000);
		expect(pollRes.currency).toBe("KES");
	});
});
