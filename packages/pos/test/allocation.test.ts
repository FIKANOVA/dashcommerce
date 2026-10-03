import { describe, expect, it } from "bun:test";
import { checkOfflineSaleEligibility } from "../src/allocation/allocation-guard";
import type { PosOperatorSession, PosStockAllocation } from "../src/types";

describe("POS Stock Allocation & Offline Guards", () => {
	const validSession: PosOperatorSession = {
		operatorId: "op_1",
		operatorName: "Jane",
		deviceId: "kiosk_1",
		authenticatedAt: new Date().toISOString(),
		expiresAt: new Date(Date.now() + 3600000).toISOString(),
		permissions: ["pos:sell"],
	};

	it("allows offline sale when local allocation is sufficient and unexpired", async () => {
		const res = await checkOfflineSaleEligibility({
			lines: [
				{
					productId: "prod_hat",
					title: "Nondies Cap",
					quantity: 2,
					unitPrice: 150000,
					tax: 0,
					lineSubtotal: 300000,
				},
			],
			session: validSession,
			getAllocation: async () => ({
				productId: "prod_hat",
				deviceId: "kiosk_1",
				allocatedQuantity: 10,
				soldQuantity: 3,
				availableQuantity: 7,
				expiresAt: new Date(Date.now() + 3600000).toISOString(),
			}),
		});

		expect(res.allowed).toBe(true);
		expect(res.allowAsDraftOnly).toBe(false);
	});

	it("converts to draft-only when requested quantity exceeds available local allocation", async () => {
		const res = await checkOfflineSaleEligibility({
			lines: [
				{
					productId: "prod_hat",
					title: "Nondies Cap",
					quantity: 8, // available is only 7
					unitPrice: 150000,
					tax: 0,
					lineSubtotal: 1200000,
				},
			],
			session: validSession,
			getAllocation: async () => ({
				productId: "prod_hat",
				deviceId: "kiosk_1",
				allocatedQuantity: 10,
				soldQuantity: 3,
				availableQuantity: 7,
				expiresAt: new Date(Date.now() + 3600000).toISOString(),
			}),
		});

		expect(res.allowed).toBe(false);
		expect(res.allowAsDraftOnly).toBe(true);
		expect(res.reason).toContain("Insufficient local device stock");
	});

	it("converts to draft-only when operator session has expired", async () => {
		const expiredSession: PosOperatorSession = {
			...validSession,
			expiresAt: new Date(Date.now() - 1000).toISOString(), // expired in past
		};

		const res = await checkOfflineSaleEligibility({
			lines: [
				{
					productId: "prod_hat",
					title: "Nondies Cap",
					quantity: 1,
					unitPrice: 150000,
					tax: 0,
					lineSubtotal: 150000,
				},
			],
			session: expiredSession,
			getAllocation: async () => ({
				productId: "prod_hat",
				deviceId: "kiosk_1",
				allocatedQuantity: 10,
				soldQuantity: 0,
				availableQuantity: 10,
				expiresAt: new Date(Date.now() + 3600000).toISOString(),
			}),
		});

		expect(res.allowed).toBe(false);
		expect(res.allowAsDraftOnly).toBe(true);
		expect(res.reason).toContain("Operator offline session has expired");
	});
});
