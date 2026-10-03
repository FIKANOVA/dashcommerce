import { describe, expect, it } from "bun:test";
import { PalplussPayoutService } from "../src/payout";

describe("PalplussPayoutService", () => {
	const credentials = {
		apiKey: "test_key",
		channelId: "654321",
	};

	const service = new PalplussPayoutService(credentials);

	it("enforces payoutRequestId for idempotency", async () => {
		await expect(
			service.executePayout({
				payoutRequestId: "",
				phoneNumber: "0712345678",
				amountMinor: 50000,
				channelId: "654321",
			}),
		).rejects.toThrow("payoutRequestId is required");
	});

	it("validates phone number and minor unit amount", async () => {
		await expect(
			service.executePayout({
				payoutRequestId: "req_1",
				phoneNumber: "invalid",
				amountMinor: 50000,
				channelId: "654321",
			}),
		).rejects.toThrow("Invalid Kenyan phone number");

		await expect(
			service.executePayout({
				payoutRequestId: "req_1",
				phoneNumber: "0712345678",
				amountMinor: -100,
				channelId: "654321",
			}),
		).rejects.toThrow("amountMinor must be a positive integer");
	});

	it("executes payout sending X-Idempotency-Key header", async () => {
		let capturedHeaders: any;
		let capturedBody: any;

		const ctx = {
			http: {
				fetch: async (_url: any, init: any) => {
					capturedHeaders = init.headers;
					capturedBody = JSON.parse(init.body);
					return new Response(
						JSON.stringify({
							status: "SUCCESS",
							transactionId: "B2C_TXN_888",
						}),
						{ status: 200 },
					);
				},
			},
		};

		const result = await service.executePayout(
			{
				payoutRequestId: "payout_idem_key_123",
				phoneNumber: "0712345678",
				amountMinor: 250000, // 2500 KES
				channelId: "654321",
				remarks: "Referee compensation",
			},
			ctx,
		);

		expect(result.status).toBe("succeeded");
		expect(result.transactionId).toBe("B2C_TXN_888");
		expect(result.recipientPhone).toBe("254712345678");

		expect(capturedHeaders["X-Idempotency-Key"]).toBe("payout_idem_key_123");
		expect(capturedBody.amount).toBe(2500);
		expect(capturedBody.phoneNumber).toBe("254712345678");
		expect(capturedBody.channelId).toBe("654321");
		expect(capturedBody.remarks).toBe("Referee compensation");
	});

	it("handles B2C failure cleanly without throwing unhandled exceptions", async () => {
		const ctx = {
			http: {
				fetch: async () =>
					new Response(
						JSON.stringify({
							error: "Insufficient B2C utility account balance",
						}),
						{ status: 400 },
					),
			},
		};

		const result = await service.executePayout(
			{
				payoutRequestId: "payout_idem_fail",
				phoneNumber: "0712345678",
				amountMinor: 100000,
				channelId: "654321",
			},
			ctx,
		);

		expect(result.status).toBe("failed");
		expect(result.reason).toContain("Insufficient B2C utility account balance");
	});
});
