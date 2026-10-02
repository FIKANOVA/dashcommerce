/**
 * POS Tender Boundaries and Validation.
 *
 * Rules:
 *   - Cash: can be recorded offline within allocated stock and a valid operator session.
 *   - Electronic tenders (mpesa_stk, card_terminal): require online verification.
 *     Offline cannot mark paid or auto-replay charges.
 *   - Split tender: multiple tender lines on one sale with exact sum/change rules.
 *     Never complete a mixed sale while its electronic tender is unverified/pending.
 */

import type { Money, OrderTenderLine } from "../types";

export interface TenderValidationResult {
	valid: boolean;
	totalTendered: number;
	changeDue: number;
	reason?: string;
}

export function validateTenderLines(
	orderTotal: Money,
	tenders: OrderTenderLine[],
): TenderValidationResult {
	if (!tenders || tenders.length === 0) {
		return {
			valid: false,
			totalTendered: 0,
			changeDue: 0,
			reason: "No tender lines provided",
		};
	}

	// Currency match check
	for (const t of tenders) {
		if (t.amount.currency.toUpperCase() !== orderTotal.currency.toUpperCase()) {
			return {
				valid: false,
				totalTendered: 0,
				changeDue: 0,
				reason: `Currency mismatch: tender currency ${t.amount.currency} does not match order currency ${orderTotal.currency}`,
			};
		}
	}

	// Electronic tenders cannot remain pending when completing an order
	const unverifiedElectronic = tenders.some(
		(t) =>
			(t.type === "mpesa_stk" || t.type === "card_terminal" || t.type === "mpesa_qr") &&
			t.status !== "completed",
	);

	if (unverifiedElectronic) {
		return {
			valid: false,
			totalTendered: 0,
			changeDue: 0,
			reason: "Cannot complete order: electronic tender is unverified or pending",
		};
	}

	// Calculate total completed tender amount
	const completedTotal = tenders
		.filter((t) => t.status === "completed")
		.reduce((sum, t) => sum + t.amount.amount, 0);

	if (completedTotal < orderTotal.amount) {
		return {
			valid: false,
			totalTendered: completedTotal,
			changeDue: 0,
			reason: `Underpaid: order total is ${orderTotal.amount} but tendered total is ${completedTotal}`,
		};
	}

	const changeDue = completedTotal - orderTotal.amount;

	// Only cash tender is allowed to overpay and produce change
	if (changeDue > 0) {
		const hasCash = tenders.some((t) => t.type === "cash" && t.status === "completed");
		if (!hasCash) {
			return {
				valid: false,
				totalTendered: completedTotal,
				changeDue: 0,
				reason: `Exact payment required for electronic tenders: overpaid by ${changeDue} without cash tender`,
			};
		}
	}

	return {
		valid: true,
		totalTendered: completedTotal,
		changeDue,
	};
}
