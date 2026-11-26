/**
 * Hosted checkout has its own shipping step, so the order summary must
 * not list the shipping options a second time. The embedded Stripe form
 * has no shipping step and keeps the summary's picker.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { shippingTotalRow, showsShippingOptions } from "../src/astro/islands/CheckoutSidebarIsland";

const kes = (amount: number) => ({ amount, currency: "KES" });
const format = (m: { amount: number; currency: string }) =>
	`${m.currency} ${(m.amount / 100).toFixed(2)}`;

describe("which summary lists shipping options", () => {
	it("lists them when the picker is on and there are options for the address", () => {
		expect(showsShippingOptions(true, true, 2)).toBe(true);
	});

	it("doesn't list them with the picker off, without an address, or with no options", () => {
		expect(showsShippingOptions(false, true, 2)).toBe(false);
		expect(showsShippingOptions(true, false, 2)).toBe(false);
		expect(showsShippingOptions(true, true, 0)).toBe(false);
	});
});

describe("the summary's shipping row", () => {
	it("names the chosen option when the picker is off", () => {
		expect(shippingTotalRow(false, { label: "Standard shipping" }, kes(500), format)).toEqual({
			label: "Shipping · Standard shipping",
			value: "KES 5.00",
		});
	});

	it("reads Free for a zero-priced option such as free pickup", () => {
		expect(shippingTotalRow(false, { label: "Store pickup" }, kes(0), format)).toEqual({
			label: "Shipping · Store pickup",
			value: "Free",
		});
	});

	it("keeps the plain row with the picker on, as before", () => {
		expect(shippingTotalRow(true, { label: "Standard shipping" }, kes(500), format)).toEqual({
			label: "Shipping",
			value: "KES 5.00",
		});
		expect(shippingTotalRow(true, { label: "Store pickup" }, kes(0), format)).toBeNull();
	});

	it("shows nothing before an option is chosen and while shipping is free", () => {
		expect(shippingTotalRow(false, undefined, kes(0), format)).toBeNull();
	});
});

describe("wiring", () => {
	it("the Astro wrapper passes the prop and the starter turns it off for hosted checkout", () => {
		const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
		expect(read("../src/astro/components/CheckoutSidebar.astro")).toContain(
			"shippingPicker={shippingPicker}",
		);
		expect(read("../../starter/src/pages/checkout.astro")).toContain(
			"<CheckoutSidebar shippingPicker={useStripeElements} />",
		);
	});
});
