/**
 * The coupon box is shared by the cart page and the checkout order
 * summary, so a shopper who goes straight from the drawer to checkout
 * can still enter a code.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import CouponBox from "../src/astro/islands/CouponBox";

const ISLANDS = new URL("../src/astro/islands/", import.meta.url);

function islandSource(name: string): string {
	return readFileSync(fileURLToPath(new URL(name, ISLANDS)), "utf8");
}

describe("CouponBox", () => {
	it("lists applied codes with their discount and a Remove button", () => {
		const html = renderToStaticMarkup(
			<CouponBox
				coupons={[
					{
						code: "SAVE10",
						discountAmount: { currency: "KES", amount: 50000 },
						freeShipping: false,
					},
					{ code: "SHIPFREE", discountAmount: { currency: "KES", amount: 0 }, freeShipping: true },
				]}
				onCart={() => {}}
			/>,
		);
		expect(html).toContain("<code>SAVE10</code>");
		expect(html).toContain('aria-label="Remove coupon SAVE10"');
		expect(html).toContain("500.00");
		expect(html).toContain("(free shipping)");
		expect(html).toContain('aria-label="Remove coupon SHIPFREE"');
	});

	it("shows the code form, with Apply disabled until a code is typed", () => {
		const html = renderToStaticMarkup(<CouponBox coupons={[]} onCart={() => {}} />);
		expect(html).toContain("Have a code?");
		expect(html).toMatch(/<button type="submit" disabled="">Apply<\/button>/);
		expect(html).not.toContain('<ul class="dc-applied-coupons">');
	});

	it("locks its controls while the host is busy", () => {
		const html = renderToStaticMarkup(
			<CouponBox
				coupons={[
					{ code: "SAVE10", discountAmount: { currency: "KES", amount: 100 }, freeShipping: false },
				]}
				onCart={() => {}}
				disabled
			/>,
		);
		expect(html).toMatch(/<input type="text"[^>]*disabled=""/);
		expect(html).toMatch(/<button type="button" disabled=""[^>]*aria-label="Remove coupon SAVE10"/);
	});

	it("uses the heading level it is given", () => {
		expect(
			renderToStaticMarkup(<CouponBox coupons={[]} onCart={() => {}} headingLevel={4} />),
		).toContain("<h4>Coupon</h4>");
		expect(renderToStaticMarkup(<CouponBox coupons={[]} onCart={() => {}} />)).toContain(
			"<h3>Coupon</h3>",
		);
	});
});

describe("coupon entry on the storefront", () => {
	it("the checkout order summary renders the coupon box", () => {
		const src = islandSource("CheckoutSidebarIsland.tsx");
		expect(src).toContain('from "./CouponBox"');
		expect(src).toMatch(/<CouponBox<CartState>\s/);
	});

	it("the cart page renders the same coupon box", () => {
		const src = islandSource("CartPageIsland.tsx");
		expect(src).toContain('from "./CouponBox"');
		expect(src).toMatch(/<CouponBox<CartState>\s/);
	});

	it("the checkout summary can turn the box off, and the starter does for Stripe Elements", () => {
		const src = islandSource("CheckoutSidebarIsland.tsx");
		expect(src).toContain("couponEntry = true,");
		expect(src).toContain("{couponEntry && (");
		const wrapper = readFileSync(
			fileURLToPath(new URL("../src/astro/components/CheckoutSidebar.astro", import.meta.url)),
			"utf8",
		);
		expect(wrapper).toContain("couponEntry={couponEntry}");
		const starter = readFileSync(
			fileURLToPath(new URL("../../starter/src/pages/checkout.astro", import.meta.url)),
			"utf8",
		);
		expect(starter).toContain("<CheckoutSidebar couponEntry={!useStripeElements} />");
	});
});
