/**
 * Order receipt — fires on successful payment (PaymentIntent succeeded
 * or Checkout Session completed, both handled in `routes/webhook.ts`).
 *
 * Minimal buyer-facing content: greeting, order number, line items,
 * totals table, a link back to the order (if we can construct one).
 * The order detail URL is host-site specific; we accept it as an
 * optional prop so the caller can wire `/thank-you/{orderDraftId}`
 * or `/account/orders/{orderNumber}`.
 */

import type { PluginContext } from "emdash";
import type { Order, OrderItem } from "../types";
import { taxRows } from "../astro/tax-rows";
import { formatMoney, greet } from "./format";
import { escapeHtml, renderHtml } from "./layout";

export interface ComposeReceiptInput {
	order: Order;
	items: OrderItem[];
	siteName: string;
	viewOrderUrl?: string;
}

export interface ComposedEmail {
	subject: string;
	text: string;
	html: string;
}

/** The pickup lines to show, or null when the order is delivered. */
function pickupRows(order: Order): Array<{ label: string; value: string }> | null {
	if (!order.pickup) return null;
	const rows: Array<{ label: string; value: string }> = [];
	if (order.pickup.location) rows.push({ label: "Collect from", value: order.pickup.location });
	if (order.pickup.hours) rows.push({ label: "Opening hours", value: order.pickup.hours });
	if (order.pickup.instructions) rows.push({ label: "Directions", value: order.pickup.instructions });
	return rows;
}

export function composeOrderReceipt(input: ComposeReceiptInput): ComposedEmail {
	const { order, items, siteName, viewOrderUrl } = input;

	const subject = `Your order ${order.orderNumber} from ${siteName}`;
	const pickup = pickupRows(order);
	const nextStep = pickup
		? "Bring your order number when you collect."
		: "we'll email again when it ships.";

	const textLines = [
		greet(order.billingAddress.firstName),
		"",
		`Thanks for your order. Payment received — ${nextStep}`,
		"",
		`Order: ${order.orderNumber}`,
		...items.map(
			(it) => `  ${it.quantity} × ${it.name} — ${formatMoney(it.total)}`,
		),
		"",
		...(pickup
			? [
					`Pickup${order.shippingMethodLabel ? ` (${order.shippingMethodLabel})` : ""}`,
					...pickup.map((row) => `  ${row.label}: ${row.value.replace(/\n/g, "\n    ")}`),
					"",
				]
			: []),
		`Subtotal: ${formatMoney(order.subtotal)}`,
	];
	if (order.discountTotal.amount > 0) {
		textLines.push(`Discount: -${formatMoney(order.discountTotal)}`);
	}
	if (order.shippingTotal.amount > 0) {
		textLines.push(`Shipping: ${formatMoney(order.shippingTotal)}`);
	}
	for (const row of taxRows(order.taxLines, order.taxTotal)) {
		textLines.push(`${row.label}: ${formatMoney(row.amount)}`);
	}
	textLines.push(`Total: ${formatMoney(order.total)}`);
	if (viewOrderUrl) {
		textLines.push("", `View your order: ${viewOrderUrl}`);
	}
	textLines.push("", `— ${siteName}`);

	const itemsRows = items
		.map(
			(it) => `
				<tr>
					<td class="qty">${it.quantity}×</td>
					<td>${escapeHtml(it.name)}</td>
					<td class="amt">${escapeHtml(formatMoney(it.total))}</td>
				</tr>`,
		)
		.join("");

	const totalRows: string[] = [
		`<tr><td>Subtotal</td><td class="amt">${escapeHtml(formatMoney(order.subtotal))}</td></tr>`,
	];
	if (order.discountTotal.amount > 0) {
		totalRows.push(
			`<tr><td>Discount</td><td class="amt">−${escapeHtml(formatMoney(order.discountTotal))}</td></tr>`,
		);
	}
	if (order.shippingTotal.amount > 0) {
		totalRows.push(
			`<tr><td>Shipping</td><td class="amt">${escapeHtml(formatMoney(order.shippingTotal))}</td></tr>`,
		);
	}
	for (const row of taxRows(order.taxLines, order.taxTotal)) {
		totalRows.push(
			`<tr><td>${escapeHtml(row.label)}</td><td class="amt">${escapeHtml(formatMoney(row.amount))}</td></tr>`,
		);
	}
	totalRows.push(
		`<tr class="grand"><td>Total</td><td class="amt">${escapeHtml(formatMoney(order.total))}</td></tr>`,
	);

	const pickupHtml = pickup
		? `
	<h2>Pickup${order.shippingMethodLabel ? ` · ${escapeHtml(order.shippingMethodLabel)}` : ""}</h2>
	<table class="totals" role="presentation">${pickup
		.map(
			(row) =>
				`<tr><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.value).replace(/\n/g, "<br>")}</td></tr>`,
		)
		.join("")}</table>
`
		: "";

	const button = viewOrderUrl
		? `<p style="margin-top:20px;"><a class="btn" href="${escapeHtml(viewOrderUrl)}">View order</a></p>`
		: "";

	const body = `
	<h1>Order ${escapeHtml(order.orderNumber)} confirmed</h1>
	<p>${escapeHtml(greet(order.billingAddress.firstName))}</p>
	<p>Thanks for your order. Your payment of <strong>${escapeHtml(formatMoney(order.total))}</strong> has been received — ${escapeHtml(nextStep)}</p>

	<h2>Items</h2>
	<table class="lines" role="presentation">${itemsRows}</table>
${pickupHtml}
	<h2>Summary</h2>
	<table class="totals" role="presentation">${totalRows.join("")}</table>
${button}
	<p class="muted" style="margin-top:24px;">Questions? Just reply to this email.</p>`;

	return {
		subject,
		text: textLines.join("\n"),
		html: renderHtml({
			siteName,
			preheader: `Order ${order.orderNumber} — ${formatMoney(order.total)}`,
			body,
		}),
	};
}

export async function sendOrderReceipt(
	ctx: PluginContext,
	order: Order,
	items: OrderItem[],
	viewOrderUrl?: string,
): Promise<void> {
	if (!ctx.email) {
		ctx.log.debug("No email provider — skipping order receipt", {
			orderId: order.id,
		});
		return;
	}
	try {
		const { subject, text, html } = composeOrderReceipt({
			order,
			items,
			siteName: ctx.site.name,
			...(viewOrderUrl ? { viewOrderUrl } : {}),
		});
		await ctx.email.send({ to: order.customerEmail, subject, text, html });
	} catch (err) {
		ctx.log.warn("Failed to send order receipt", {
			orderId: order.id,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
