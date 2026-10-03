import { describe, expect, it } from "bun:test";
import { validatePosTenders } from "../src/tenders/tender";

describe("POS Tender Semantics", () => {
	it("cash: allows overpayment and computes changeDue accurately", () => {
		const res = validatePosTenders({
			saleTotal: 250000, // KES 2,500
			currency: "KES",
			isOnline: false,
			tenders: [
				{
					id: "t_cash_1",
					type: "cash",
					amount: 300000, // tendered KES 3,000
					currency: "KES",
					verified: true,
				},
			],
		});

		expect(res.valid).toBe(true);
		expect(res.status).toBe("completed");
		expect(res.totalTendered).toBe(300000);
		expect(res.changeDue).toBe(50000); // KES 500 change
	});

	it("card_terminal: rejects overpayment on electronic tenders", () => {
		const res = validatePosTenders({
			saleTotal: 100000,
			currency: "KES",
			isOnline: false,
			tenders: [
				{
					id: "t_card_1",
					type: "card_terminal",
					amount: 120000, // overpaid
					currency: "KES",
					verified: true,
					externalReference: "TERM_AUTH_998",
				},
			],
		});

		expect(res.valid).toBe(false);
		expect(res.errors[0]).toContain("Overpayment is only permitted on cash tender");
	});

	it("card_terminal: requires external terminal reference", () => {
		const res = validatePosTenders({
			saleTotal: 100000,
			currency: "KES",
			isOnline: false,
			tenders: [
				{
					id: "t_card_1",
					type: "card_terminal",
					amount: 100000,
					currency: "KES",
					verified: true,
					// missing externalReference
				},
			],
		});

		expect(res.valid).toBe(false);
		expect(res.errors[0]).toContain("card_terminal tender requires an external terminal reference");
	});

	it("split tender: blocks completing mixed sale while electronic tender is unverified", () => {
		const res = validatePosTenders({
			saleTotal: 500000,
			currency: "KES",
			isOnline: true,
			tenders: [
				{
					id: "t_cash",
					type: "cash",
					amount: 200000,
					currency: "KES",
					verified: true,
				},
				{
					id: "t_stk",
					type: "mpesa_stk",
					amount: 300000,
					currency: "KES",
					verified: false, // STK prompt not yet approved on customer phone
				},
			],
			allowDraft: true,
		});

		expect(res.valid).toBe(true);
		expect(res.status).toBe("draft"); // Saved as draft, not completed!
	});

	it("rejects currency mismatch between sale and tender", () => {
		const res = validatePosTenders({
			saleTotal: 500000,
			currency: "KES",
			isOnline: false,
			tenders: [
				{
					id: "t_usd",
					type: "cash",
					amount: 500000,
					currency: "USD",
					verified: true,
				},
			],
		});

		expect(res.valid).toBe(false);
		expect(res.errors[0]).toContain("Tender currency mismatch");
	});
});
