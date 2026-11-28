/**
 * Counter sale paid by link ("Pay on their phone"): the payment link,
 * emailed to the customer when staff entered their email. It carries only
 * the total, the shop's name and the provider's link.
 */

import type { PluginContext } from "emdash";
import type { Money } from "../money";
import { formatMoney } from "./format";
import { escapeHtml, renderHtml } from "./layout";
import type { ComposedEmail } from "./receipt";

export interface ComposeCounterLinkInput {
	url: string;
	total: Money;
	siteName: string;
}

export function composeCounterPaymentLink(input: ComposeCounterLinkInput): ComposedEmail {
	const { url, total, siteName } = input;
	const amount = formatMoney(total);
	const subject = `Pay ${amount} to ${siteName}`;
	const text = [
		`Here is the link to pay ${amount} for your purchase at ${siteName}:`,
		"",
		url,
		"",
		"Your purchase is complete once the shop's screen shows it as paid.",
		"",
		`— ${siteName}`,
	].join("\n");
	const body = `
	<h1>Pay for your purchase</h1>
	<p>Here is the link to pay <strong>${escapeHtml(amount)}</strong> for your purchase at ${escapeHtml(siteName)}.</p>
	<p><a href="${escapeHtml(url)}">Pay ${escapeHtml(amount)}</a></p>
	<p class="muted">${escapeHtml(url)}</p>
	<p class="muted">Your purchase is complete once the shop's screen shows it as paid.</p>`;
	return {
		subject,
		text,
		html: renderHtml({ siteName, preheader: `Pay ${amount} to ${siteName}`, body }),
	};
}

/**
 * Send the link with the shop's EmDash email. Returns whether it went: a
 * failure is logged and shown on the counter page, never fatal to the sale.
 */
export async function sendCounterPaymentLink(
	ctx: PluginContext,
	input: { to: string; url: string; total: Money },
): Promise<boolean> {
	if (!ctx.email) return false;
	try {
		const { subject, text, html } = composeCounterPaymentLink({
			url: input.url,
			total: input.total,
			siteName: ctx.site.name,
		});
		await ctx.email.send({ to: input.to, subject, text, html });
		return true;
	} catch (err) {
		ctx.log.warn("Counter sale: couldn't email the payment link", {
			error: err instanceof Error ? err.message : String(err),
		});
		return false;
	}
}
