/**
 * Tax rows name the rate ("VAT 16%") on the cart, the checkout summary and
 * the receipt, instead of a bare "Tax".
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { taxLineLabel, taxRows } from "../src/astro/tax-rows";
import { composeOrderReceipt } from "../src/emails/receipt";
import type { Order } from "../src/types";

const kes = (amount: number) => ({ amount, currency: "KES" });

describe("taxLineLabel", () => {
	it("adds the rate to the rate's name", () => {
		expect(taxLineLabel({ label: "VAT", amount: kes(24016), rate: 16 })).toBe("VAT 16%");
		expect(taxLineLabel({ label: "Levy", amount: kes(100), rate: 1.5 })).toBe("Levy 1.5%");
	});

	it("leaves a name that already states its percentage", () => {
		expect(taxLineLabel({ label: "GB 20%", amount: kes(100), rate: 20 })).toBe("GB 20%");
	});

	it("falls back to Tax for an empty name", () => {
		expect(taxLineLabel({ label: " ", amount: kes(100), rate: 16 })).toBe("Tax 16%");
	});
});

describe("taxRows", () => {
	it("gives one row per tax line", () => {
		const rows = taxRows(
			[
				{ label: "VAT", amount: kes(24016), rate: 16 },
				{ label: "County levy", amount: kes(3002), rate: 2 },
			],
			kes(27018),
		);
		expect(rows).toEqual([
			{ label: "VAT 16%", amount: kes(24016) },
			{ label: "County levy 2%", amount: kes(3002) },
		]);
	});

	it("shows a total without lines as one Tax row, and nothing for zero tax", () => {
		expect(taxRows(undefined, kes(500))).toEqual([{ label: "Tax", amount: kes(500) }]);
		expect(taxRows([], kes(0))).toEqual([]);
	});
});

describe("the receipt email", () => {
	const order = {
		orderNumber: "DC-1001",
		billingAddress: {
			firstName: "Wanjiru",
			lastName: "Kamau",
			line1: "",
			city: "",
			region: "",
			postalCode: "",
			country: "KE",
		},
		subtotal: kes(150099),
		discountTotal: kes(0),
		shippingTotal: kes(0),
		taxTotal: kes(24016),
		taxLines: [{ label: "VAT", amount: kes(24016), rate: 16 }],
		total: kes(174115),
	} as unknown as Order;

	it("names the tax rate in both the HTML and the text version", () => {
		const email = composeOrderReceipt({ order, items: [], siteName: "My Shop" });
		expect(email.html).toContain("<td>VAT 16%</td>");
		expect(email.text).toContain("VAT 16%: ");
		expect(email.html).not.toContain("<td>Tax</td>");
	});
});

describe("cart and checkout summary", () => {
	const source = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");

	it("render their tax rows from the cart's tax lines", () => {
		for (const island of ["CheckoutSidebarIsland.tsx", "CartPageIsland.tsx"]) {
			const src = source(`../src/astro/islands/${island}`);
			expect(src).toContain("taxRows(cart.taxLines, cart.taxTotal)");
			expect(src).not.toContain("<span>Tax</span>");
		}
	});
});
