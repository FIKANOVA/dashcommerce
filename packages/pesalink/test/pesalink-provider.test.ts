import { describe, expect, it } from "bun:test";
import { PesalinkPaymentProvider } from "../src/provider";

const credentials = {
	apiKey: "psl_client_key_123",
	secretKey: "psl_secret_456",
	channelId: "01", // Bank Code (e.g. KCB)
	accountNumber: "1234567890",
};

describe("PesalinkPaymentProvider", () => {
	it("supportsCurrency enforces KES only", () => {
		const provider = new PesalinkPaymentProvider();
		expect(provider.supportsCurrency("KES")).toBe(true);
		expect(provider.supportsCurrency("kes")).toBe(true);
		expect(provider.supportsCurrency("USD")).toBe(false);
	});

	it("formatAmount formats minor units in KES", () => {
		const provider = new PesalinkPaymentProvider();
		expect(provider.formatAmount({ amount: 750000, currency: "KES" })).toContain("7,500.00");
	});

	it("initCheckout generates interbank routing reference and pending status", async () => {
		const provider = new PesalinkPaymentProvider({
			bankName: "KCB Bank Kenya",
			accountName: "Nondescripts RFC",
		});

		const ctx = {
			http: { fetch: fetch },
			log: { info: () => {}, warn: () => {}, error: () => {} },
		};

		const result = await provider.initCheckout(
			ctx,
			{
				orderDraftId: "ord_fik_plk_1001",
				amount: 750000,
				currency: "KES",
				successUrl: "https://example.com/checkout/return",
				cancelUrl: "https://example.com/checkout/cancel",
				customer: { email: "fan@nondies.co.ke" },
				lineItems: [],
			},
			credentials,
		);

		expect(result.kind).toBe("pending");
		expect(result.checkoutReference).toBe("ord_fik_plk_1001");
		expect(result.providerReference).toContain("PLK-");
	});

	it("verifyWebhook returns ok: true when pesalinkReference is present", async () => {
		const provider = new PesalinkPaymentProvider();
		const result = await provider.verifyWebhook({
			rawBody: JSON.stringify({
				transactionId: "TX123456",
				pesalinkReference: "PLK-TRACE-8888",
				amount: 7500,
				status: "SUCCESS",
			}),
			signatureHeader: "",
			secret: "",
		});

		expect(result.ok).toBe(true);
	});

	it("parseWebhookEvent maps IPSL settlement into charge.succeeded", () => {
		const provider = new PesalinkPaymentProvider();
		const event = provider.parseWebhookEvent(
			JSON.stringify({
				transactionId: "TX999888",
				reference: "ord_fik_plk_1001",
				pesalinkReference: "PLK-TRACE-8888",
				amount: 7500,
				currency: "KES",
				sourceBankCode: "11",
				destinationBankCode: "01",
				destinationAccount: "1234567890",
				status: "SUCCESS",
				timestamp: "2026-10-04T14:30:00Z",
			}),
		);

		expect(event.type).toBe("charge.succeeded");
		if (event.type === "charge.succeeded") {
			expect(event.providerId).toBe("pesalink");
			expect(event.checkoutReference).toBe("ord_fik_plk_1001");
			expect(event.paymentReference).toBe("PLK-TRACE-8888");
			expect(event.amount).toBe(750000);
			expect(event.currency).toBe("KES");
			expect(event.providerEventId).toBe("pesalink:PLK-TRACE-8888");
			expect(event.eventIdSource).toBe("native");
			expect(event.channel).toBe("bank_transfer");
		}
	});

	it("getPaymentStatus queries settlement API cleanly", async () => {
		const provider = new PesalinkPaymentProvider();
		const mockFetch = async () => {
			return new Response(
				JSON.stringify({
					transactionId: "TX999888",
					reference: "ord_fik_plk_1001",
					pesalinkReference: "PLK-TRACE-8888",
					amount: 7500,
					currency: "KES",
					status: "SUCCESS",
					message: "Settlement cleared across IPSL switch",
				}),
				{ status: 200 },
			);
		};

		const ctx = {
			http: { fetch: mockFetch as unknown as typeof fetch },
			log: { info: () => {}, warn: () => {}, error: () => {} },
		};

		const result = await provider.getPaymentStatus(
			ctx,
			"PLK-TRACE-8888",
			credentials,
		);

		expect(result.status).toBe("succeeded");
		expect(result.paymentReference).toBe("PLK-TRACE-8888");
		expect(result.amount).toBe(750000);
	});
});
