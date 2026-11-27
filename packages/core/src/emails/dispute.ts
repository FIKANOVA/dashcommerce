/**
 * Dispute alert — tells the store's admins that a customer disputed a
 * payment. Sent once, when core first sees the dispute, whatever its status
 * (see `orders/dispute.ts`). Some
 * providers settle an unanswered dispute against the merchant within hours
 * (Paystack: 16), so the deadline leads.
 */

import type { PluginContext } from "emdash";
import type { Order, OrderDispute } from "../types";
import { formatMoney } from "./format";
import { escapeHtml, renderHtml } from "./layout";
import type { ComposedEmail } from "./receipt";

/** EmDash's admin role. */
const ROLE_ADMIN = 50;

/**
 * A disputed subscription renewal. Renewals are subscription invoices, not
 * orders, so the alert names the payment and the customer instead.
 */
export interface DisputedRenewal {
	kind: "renewal";
	paymentReference: string;
	subscriptionId: string;
	customerEmail?: string;
}

/** What was disputed: an order's payment, or a subscription renewal. */
export type DisputedPayment = Order | DisputedRenewal;

function isRenewal(payment: DisputedPayment): payment is DisputedRenewal {
	return (payment as DisputedRenewal).kind === "renewal";
}

export interface ComposeDisputeAlertInput {
	/** An order, or a subscription renewal (see {@link DisputedRenewal}). */
	order: DisputedPayment;
	dispute: OrderDispute;
	providerLabel: string;
	siteName: string;
}

function formatDeadline(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toUTCString().replace("GMT", "UTC");
}

/**
 * Sent when core first sees a dispute. Usually it is open and the admin must
 * answer it; a dispute first seen already settled gets wording for its
 * outcome instead.
 */
export function composeDisputeAlert(input: ComposeDisputeAlertInput): ComposedEmail {
	const { order: payment, dispute, providerLabel, siteName } = input;
	const renewal = isRenewal(payment) ? payment : undefined;
	const order = isRenewal(payment) ? undefined : payment;
	const amount = formatMoney(dispute.amount);
	const deadline = dispute.dueAt ? formatDeadline(dispute.dueAt) : null;
	const what = order ? `order ${order.orderNumber}` : "a subscription renewal";
	const short = order ? order.orderNumber : "a subscription renewal";

	const heading =
		dispute.status === "won"
			? "Dispute settled in your favour"
			: dispute.status === "lost"
				? "Dispute settled for the customer"
				: "Payment disputed";
	const subject =
		dispute.status === "won"
			? `Dispute won on ${what}`
			: dispute.status === "lost"
				? `Dispute lost on ${what}`
				: `Payment disputed on ${what}`;

	const opening = `A customer disputed ${amount} on ${what}.`;
	const outcome: string[] =
		dispute.status === "won"
			? [`${providerLabel} has already settled it in your favour, so you keep the money. Nothing to do.`]
			: dispute.status === "lost"
				? [
						`${providerLabel} has already settled it for the customer, so the money goes back to them.`,
						order
							? "DashCommerce has counted it as a refund on the order."
							: "It is not counted against any order.",
					]
				: [
						`Answer it in your ${providerLabel} dashboard (dispute ${dispute.providerDisputeId}). If it is not answered in time, the customer usually gets the money back.`,
						order ? "Don't ship this order until the dispute is resolved." : "",
					];
	const details = [
		dispute.status === "open" && deadline ? `Answer by: ${deadline}` : "",
		dispute.reason ? `Reason given: ${dispute.reason}` : "",
		renewal ? `Payment reference: ${renewal.paymentReference}` : "",
		renewal?.customerEmail ? `Customer: ${renewal.customerEmail}` : "",
		dispute.status === "open" ? "" : `${providerLabel} dispute: ${dispute.providerDisputeId}`,
	];

	const shownDetails = details.filter((line) => line !== "");
	const shownOutcome = outcome.filter((line) => line !== "");
	const text = [opening, ...shownDetails, "", ...shownOutcome, "", `— ${siteName}`].join("\n");

	const disputedOn = order
		? `order <strong>${escapeHtml(order.orderNumber)}</strong>`
		: "a subscription renewal";
	const body = `
	<h1>${escapeHtml(heading)}</h1>
	<p>A customer disputed <strong>${escapeHtml(amount)}</strong> on ${disputedOn}.</p>
	${shownDetails.map((line) => `<p class="muted">${escapeHtml(line)}</p>`).join("")}
	${shownOutcome.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}`;

	return {
		subject,
		text,
		html: renderHtml({
			siteName,
			preheader: `${amount} disputed on ${short}`,
			body,
		}),
	};
}

/**
 * Email every admin user. Quiet on failure: the dispute is already recorded
 * on the order, and the admin order page shows it.
 */
export async function sendDisputeAlert(
	ctx: PluginContext,
	order: DisputedPayment,
	dispute: OrderDispute,
	providerLabel: string,
): Promise<void> {
	const where = isRenewal(order)
		? { subscriptionId: order.subscriptionId, paymentReference: order.paymentReference }
		: { orderId: order.id };
	if (!ctx.email) {
		ctx.log.warn("No email provider configured; dispute alert not sent", {
			...where,
			providerDisputeId: dispute.providerDisputeId,
		});
		return;
	}
	try {
		const admins = ctx.users ? (await ctx.users.list({ role: ROLE_ADMIN, limit: 50 })).items : [];
		const recipients = [...new Set(admins.map((u) => u.email).filter(Boolean))];
		if (recipients.length === 0) {
			ctx.log.warn("No admin user to send the dispute alert to", {
				...where,
				providerDisputeId: dispute.providerDisputeId,
			});
			return;
		}
		const { subject, text, html } = composeDisputeAlert({
			order,
			dispute,
			providerLabel,
			siteName: ctx.site.name,
		});
		for (const to of recipients) {
			await ctx.email.send({ to, subject, text, html });
		}
	} catch (err) {
		ctx.log.warn("Failed to send dispute alert", {
			...where,
			providerDisputeId: dispute.providerDisputeId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
