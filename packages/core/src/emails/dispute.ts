/**
 * Dispute alert — tells the store's admins that a customer disputed a
 * payment. Sent once per new open dispute (see `orders/dispute.ts`). Some
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

export interface ComposeDisputeAlertInput {
	order: Order;
	dispute: OrderDispute;
	providerLabel: string;
	siteName: string;
}

function formatDeadline(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toUTCString().replace("GMT", "UTC");
}

export function composeDisputeAlert(input: ComposeDisputeAlertInput): ComposedEmail {
	const { order, dispute, providerLabel, siteName } = input;
	const amount = formatMoney(dispute.amount);
	const deadline = dispute.dueAt ? formatDeadline(dispute.dueAt) : null;
	const subject = `Payment disputed on order ${order.orderNumber}`;

	const text = [
		`A customer disputed ${amount} on order ${order.orderNumber}.`,
		deadline ? `Answer by: ${deadline}` : "",
		dispute.reason ? `Reason given: ${dispute.reason}` : "",
		"",
		`Answer it in your ${providerLabel} dashboard (dispute ${dispute.providerDisputeId}). If it is not answered in time, the customer usually gets the money back.`,
		"Don't ship this order until the dispute is resolved.",
		"",
		`— ${siteName}`,
	]
		.filter((l) => l !== "")
		.join("\n");

	const body = `
	<h1>Payment disputed</h1>
	<p>A customer disputed <strong>${escapeHtml(amount)}</strong> on order <strong>${escapeHtml(order.orderNumber)}</strong>.</p>
	${deadline ? `<p>Answer by: <strong>${escapeHtml(deadline)}</strong></p>` : ""}
	${dispute.reason ? `<p class="muted">Reason given: ${escapeHtml(dispute.reason)}</p>` : ""}
	<p>Answer it in your ${escapeHtml(providerLabel)} dashboard (dispute ${escapeHtml(dispute.providerDisputeId)}). If it is not answered in time, the customer usually gets the money back.</p>
	<p><strong>Don't ship this order until the dispute is resolved.</strong></p>`;

	return {
		subject,
		text,
		html: renderHtml({
			siteName,
			preheader: `${amount} disputed on ${order.orderNumber}`,
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
	order: Order,
	dispute: OrderDispute,
	providerLabel: string,
): Promise<void> {
	if (!ctx.email) {
		ctx.log.warn("No email provider configured; dispute alert not sent", {
			orderId: order.id,
			providerDisputeId: dispute.providerDisputeId,
		});
		return;
	}
	try {
		const admins = ctx.users ? (await ctx.users.list({ role: ROLE_ADMIN, limit: 50 })).items : [];
		const recipients = [...new Set(admins.map((u) => u.email).filter(Boolean))];
		if (recipients.length === 0) {
			ctx.log.warn("No admin user to send the dispute alert to", {
				orderId: order.id,
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
			orderId: order.id,
			providerDisputeId: dispute.providerDisputeId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
