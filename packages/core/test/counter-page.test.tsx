/**
 * The Counter sale page's "Pay on their phone" screen: the notice that only
 * this screen saying Paid means paid, the QR code drawn by the page itself,
 * and share links that each carry the exact payment link.
 */

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { shareMessage } from "../src/admin/counter-share";
import { PaidOnlyHere, PaymentQr, ShareLink } from "../src/admin/pages/CounterSalePage";
import { encodeQr, qrPath } from "../src/admin/qr";

const URL_ = "https://checkout.paystack.com/0peioxfhpn";
const share = {
	url: URL_,
	total: { amount: 160_000, currency: "KES" },
	shopName: "Corner Shop",
	customerPhone: "+254 712 345 678",
};
const sale = {
	orderDraftId: "a".repeat(32),
	status: "pending" as const,
	method: "link" as const,
	amount: 160_000,
	currency: "KES",
	paymentUrl: URL_,
};

/** What React writes for an attribute value. */
function attr(value: string): string {
	return value.replace(/&/g, "&amp;");
}

describe("Counter sale: Pay on their phone screen", () => {
	it("says a sale is paid only when this screen says Paid", () => {
		const html = renderToStaticMarkup(<PaidOnlyHere />);
		expect(html).toContain(
			"A sale is paid only when this screen says Paid — never because of a customer&#x27;s SMS or screenshot.",
		);
	});

	it("draws the QR code from the page's own code, with no outside image", () => {
		const html = renderToStaticMarkup(<PaymentQr url={URL_} />);
		const code = encodeQr(URL_);
		expect(html).toContain('aria-label="QR code for the payment link"');
		expect(html).toContain(`viewBox="0 0 ${code.size + 8} ${code.size + 8}"`);
		expect(html).toContain(`d="${qrPath(code)}"`);
		expect(html).not.toContain("<img");
		expect(html).not.toContain("http://");
	});

	it("offers WhatsApp, SMS, copy and the link itself, each with the exact link", () => {
		const html = renderToStaticMarkup(<ShareLink sale={sale} share={share} email="" />);
		const message = encodeURIComponent(shareMessage(share));
		expect(html).toContain(`href="${attr(`https://wa.me/254712345678?text=${message}`)}"`);
		expect(html).toContain(`href="${attr(`sms:+254712345678?&body=${message}`)}"`);
		expect(decodeURIComponent(message)).toContain(URL_);
		expect(html).toContain(`value="${URL_}"`);
		expect(html).toContain("Share on WhatsApp");
		expect(html).toContain("Send by SMS");
		expect(html).toContain("Copy link");
		expect(html).toContain("nothing is sent until you tap send");
	});

	it("says whether the link was emailed", () => {
		const sent = renderToStaticMarkup(
			<ShareLink sale={{ ...sale, linkEmailed: true }} share={share} email="fan@example.com" />,
		);
		expect(sent).toContain("The link was emailed to fan@example.com.");
		const failed = renderToStaticMarkup(
			<ShareLink sale={{ ...sale, linkEmailed: false }} share={share} email="fan@example.com" />,
		);
		expect(failed).toContain("The link couldn&#x27;t be emailed");
	});
});
