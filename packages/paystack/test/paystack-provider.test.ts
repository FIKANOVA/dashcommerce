import { describe, expect, it } from "bun:test";
import type { PaymentProviderRuntimeContext } from "@dashcommerce/core/payment-provider";
import { paystackPaymentProvider } from "../src/provider";

function makeMockRuntimeContext(fetchHandler: (url: string, init?: RequestInit) => Promise<Response>): PaymentProviderRuntimeContext {
	return {
		http: {
			fetch: fetchHandler,
		},
		log: {
			debug() {},
			info() {},
			warn() {},
			error() {},
		},
	};
}

describe("paystackPaymentProvider", () => {
	const credentials = { secretKey: "sk_test_paystack_secret_key" };

	describe("supportsCurrency", () => {
		it("supports primary African currencies and USD", () => {
			expect(paystackPaymentProvider.supportsCurrency("KES")).toBe(true);
			expect(paystackPaymentProvider.supportsCurrency("ngn")).toBe(true);
			expect(paystackPaymentProvider.supportsCurrency(" GHS ")).toBe(true);
			expect(paystackPaymentProvider.supportsCurrency("ZAR")).toBe(true);
			expect(paystackPaymentProvider.supportsCurrency("USD")).toBe(true);
		});

		it("rejects unsupported currencies", () => {
			expect(paystackPaymentProvider.supportsCurrency("EUR")).toBe(false);
			expect(paystackPaymentProvider.supportsCurrency("GBP")).toBe(false);
			expect(paystackPaymentProvider.supportsCurrency("JPY")).toBe(false);
			expect(paystackPaymentProvider.supportsCurrency("")).toBe(false);
		});
	});

	describe("initCheckout", () => {
		it("initializes Paystack transaction and returns redirect url with references", async () => {
			let capturedUrl = "";
			let capturedBody: Record<string, unknown> = {};

			const ctx = makeMockRuntimeContext(async (url, init) => {
				capturedUrl = url;
				capturedBody = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({
						status: true,
						message: "Authorization URL created",
						data: {
							authorization_url: "https://checkout.paystack.com/pstk_pay_abc",
							access_code: "pstk_pay_abc",
							reference: "chk_ref_12345",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});

			const result = await paystackPaymentProvider.initCheckout(
				ctx,
				{
					orderDraftId: "draft_pstk_1",
					checkoutReference: "chk_ref_12345",
					amount: 250000, // KES 2500.00
					currency: "KES",
					customer: { email: "fan@nondies.ke" },
					successUrl: "https://nondies.ke/thank-you/draft_pstk_1",
					cancelUrl: "https://nondies.ke/checkout",
					preferredChannels: ["card", "mpesa"],
				},
				credentials,
			);

			expect(capturedUrl).toBe("https://api.paystack.co/transaction/initialize");
			expect(capturedBody.email).toBe("fan@nondies.ke");
			expect(capturedBody.amount).toBe(250000);
			expect(capturedBody.currency).toBe("KES");
			expect(capturedBody.reference).toBe("dc_draft_pstk_1");
			expect(capturedBody.callback_url).toBe("https://nondies.ke/thank-you/draft_pstk_1");
			expect((capturedBody.channels as string[])).toEqual(["card", "mobile_money"]);

			expect(result.kind).toBe("redirect");
			expect(result.redirectUrl).toBe("https://checkout.paystack.com/pstk_pay_abc");
			expect(result.checkoutReference).toBe("chk_ref_12345");
			expect(result.providerReference).toBe("chk_ref_12345");
		});
	});

	describe("verifyWebhook", () => {
		async function generateSignature(secret: string, payload: string): Promise<string> {
			const enc = new TextEncoder();
			const key = await crypto.subtle.importKey(
				"raw",
				enc.encode(secret),
				{ name: "HMAC", hash: "SHA-512" },
				false,
				["sign"],
			);
			const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
			return Array.from(new Uint8Array(sig))
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
		}

		it("accepts valid HMAC-SHA512 signature", async () => {
			const body = JSON.stringify({ event: "charge.success", data: { id: 123 } });
			const signature = await generateSignature(credentials.secretKey, body);

			const result = await paystackPaymentProvider.verifyWebhook({
				rawBody: body,
				signatureHeader: signature,
				secret: credentials.secretKey,
			});

			expect(result.ok).toBe(true);
		});

		it("rejects mismatched signature", async () => {
			const body = JSON.stringify({ event: "charge.success", data: { id: 123 } });
			const wrongSignature = await generateSignature("wrong_secret", body);

			const result = await paystackPaymentProvider.verifyWebhook({
				rawBody: body,
				signatureHeader: wrongSignature,
				secret: credentials.secretKey,
			});

			expect(result.ok).toBe(false);
			expect(result.reason).toContain("Signature mismatch");
		});

		it("rejects missing signature or secret", async () => {
			const result1 = await paystackPaymentProvider.verifyWebhook({
				rawBody: "{}",
				signatureHeader: "",
				secret: credentials.secretKey,
			});
			expect(result1.ok).toBe(false);

			const result2 = await paystackPaymentProvider.verifyWebhook({
				rawBody: "{}",
				signatureHeader: "abc",
				secret: "",
			});
			expect(result2.ok).toBe(false);
		});
	});

	describe("parseWebhookEvent", () => {
		it("parses charge.success into charge.succeeded with separated references", () => {
			const rawPayload = JSON.stringify({
				event: "charge.success",
				data: {
					id: 99887766,
					reference: "chk_ref_9988",
					amount: 350000,
					currency: "KES",
					status: "success",
					customer: {
						email: "captain@nondies.ke",
						first_name: "Biko",
						last_name: "Adema",
						phone: "+254711223344",
					},
					channel: "mobile_money",
					metadata: {
						orderDraftId: "draft_adema_1",
						checkoutReference: "chk_ref_9988",
					},
				},
			});

			const parsed = paystackPaymentProvider.parseWebhookEvent(rawPayload);

			expect(parsed.type).toBe("charge.succeeded");
			expect(parsed.orderDraftId).toBe("draft_adema_1");
			expect(parsed.checkoutReference).toBe("chk_ref_9988");
			expect(parsed.paymentReference).toBe("99887766");
			expect(parsed.providerReference).toBe("chk_ref_9988");
			expect(parsed.providerEventId).toBe("99887766");
			expect(parsed.eventIdSource).toBe("native");
			expect(parsed.amount).toBe(350000);
			expect(parsed.currency).toBe("KES");
			expect(parsed.customer?.email).toBe("captain@nondies.ke");
			expect(parsed.customer?.name).toBe("Biko Adema");
			expect(parsed.customer?.phone).toBe("+254711223344");
			expect(parsed.channel).toBe("M-Pesa");
		});

		it("parses charge.failed into charge.failed with reason", () => {
			const rawPayload = JSON.stringify({
				event: "charge.failed",
				data: {
					id: 112233,
					reference: "chk_ref_fail",
					amount: 100000,
					currency: "KES",
					gateway_response: "Insufficient funds in M-Pesa wallet",
					metadata: {
						orderDraftId: "draft_fail_1",
					},
				},
			});

			const parsed = paystackPaymentProvider.parseWebhookEvent(rawPayload);

			expect(parsed.type).toBe("charge.failed");
			expect(parsed.orderDraftId).toBe("draft_fail_1");
			expect(parsed.reason).toBe("Insufficient funds in M-Pesa wallet");
			expect(parsed.paymentReference).toBe("112233");
		});

		it("returns unhandled on unparseable JSON without throwing", () => {
			const parsed = paystackPaymentProvider.parseWebhookEvent("invalid-json-body");
			expect(parsed.type).toBe("unhandled");
			expect(parsed.providerEventType).toBe("unparseable");
		});

		it("returns unhandled when event lacks orderDraftId correlation", () => {
			const rawPayload = JSON.stringify({
				event: "charge.success",
				data: {
					id: 554433,
					reference: "no_draft_id",
					amount: 1000,
				},
			});

			const parsed = paystackPaymentProvider.parseWebhookEvent(rawPayload);
			expect(parsed.type).toBe("unhandled");
		});
	});

	describe("getPaymentStatus", () => {
		it("reconciles payment status via transaction/verify", async () => {
			const ctx = makeMockRuntimeContext(async (url) => {
				expect(url).toContain("/transaction/verify/chk_ref_verify");
				return new Response(
					JSON.stringify({
						status: true,
						message: "Verification successful",
						data: {
							id: 776655,
							status: "success",
							reference: "chk_ref_verify",
							amount: 450000,
							currency: "KES",
							channel: "mobile_money",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});

			const status = await paystackPaymentProvider.getPaymentStatus?.(
				ctx,
				"chk_ref_verify",
				credentials,
			);

			expect(status?.status).toBe("succeeded");
			expect(status?.paymentReference).toBe("776655");
			expect(status?.amount).toBe(450000);
			expect(status?.currency).toBe("KES");
		});
	});

	describe("refund", () => {
		it("executes refund with explicit refundRequestId idempotency note", async () => {
			let capturedBody: Record<string, unknown> = {};

			const ctx = makeMockRuntimeContext(async (url, init) => {
				expect(url).toBe("https://api.paystack.co/refund");
				capturedBody = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({
						status: true,
						message: "Refund queued",
						data: {
							id: 990011,
							status: "processed",
							amount: 250000,
							currency: "KES",
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			});

			const result = await paystackPaymentProvider.refund(
				ctx,
				{
					refundRequestId: "ref_req_ticket_cancel_1",
					paymentReference: "99887766",
					amount: 250000,
					currency: "KES",
					reason: "Event cancelled",
				},
				credentials,
			);

			expect(capturedBody.transaction).toBe("99887766");
			expect(capturedBody.amount).toBe(250000);
			expect(capturedBody.currency).toBe("KES");
			expect(capturedBody.merchant_note).toBe("ref_req_ticket_cancel_1: Event cancelled");

			expect(result.status).toBe("succeeded");
			expect(result.providerRefundId).toBe("990011");
			expect(result.amount).toBe(250000);
			expect(result.currency).toBe("KES");
		});

		it("throws when refundRequestId is missing", async () => {
			const ctx = makeMockRuntimeContext(async () => new Response());

			await expect(
				paystackPaymentProvider.refund(
					ctx,
					{
						refundRequestId: "",
						paymentReference: "99887766",
						amount: 1000,
						currency: "KES",
					},
					credentials,
				),
			).rejects.toThrow(/refundRequestId/);
		});
	});

	describe("formatAmount", () => {
		it("formats major units with currency code", () => {
			expect(paystackPaymentProvider.formatAmount({ amount: 250000, currency: "KES" })).toBe("KES 2500.00");
			expect(paystackPaymentProvider.formatAmount({ amount: 999, currency: "USD" })).toBe("USD 9.99");
		});
	});
});
