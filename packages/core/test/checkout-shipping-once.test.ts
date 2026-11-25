/**
 * Hosted checkout has its own shipping step, so the order summary must
 * not list the shipping options a second time. The embedded Stripe form
 * has no shipping step and keeps the summary's picker.
 *
 * The island renders "Loading summary…" until its fetch runs, and core
 * has no DOM test setup, so these check the wiring in source.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(relative: string): string {
	return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const island = source("../src/astro/islands/CheckoutSidebarIsland.tsx");
const wrapper = source("../src/astro/components/CheckoutSidebar.astro");
const starterCheckout = source("../../starter/src/pages/checkout.astro");

describe("order summary shipping picker", () => {
	it("is on by default, so existing sites keep it", () => {
		expect(island).toMatch(/shippingPicker = true,/);
		expect(wrapper).toMatch(/shippingPicker = true \} = Astro\.props/);
	});

	it("passes the prop from the Astro wrapper to the island", () => {
		expect(wrapper).toContain("shippingPicker={shippingPicker}");
	});

	it("lists the options and fetches them only when the picker is on", () => {
		expect(island).toContain(
			"{shippingPicker && Boolean(cart.shippingAddress) && methods.length > 0 && (",
		);
		expect(island).toContain("if (shippingPicker && body.cart.shippingAddress) {");
	});

	it("shows the chosen option in the totals when the picker is off", () => {
		expect(island).toContain("!shippingPicker && cart.shippingMethod ?");
		expect(island).toContain("Shipping · {cart.shippingMethod.label}");
	});

	it("the starter keeps the picker only for the embedded Stripe form", () => {
		expect(starterCheckout).toContain("<CheckoutSidebar shippingPicker={useStripeElements} />");
	});
});
