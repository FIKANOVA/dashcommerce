/**
 * The tax rows a cart, checkout summary or receipt shows: one per tax
 * line, named by the rate ("VAT 16%"), so a table rate's own name reaches
 * the customer. A total with no lines (an older cart or order) shows as a
 * single "Tax" row.
 */

interface Money {
	currency: string;
	amount: number;
}

export interface TaxLineLike {
	label: string;
	amount: Money;
	rate?: number;
}

export interface TaxRow {
	label: string;
	amount: Money;
}

/** "VAT" at 16 → "VAT 16%". A label that already names its percentage is left alone. */
export function taxLineLabel(line: TaxLineLike): string {
	const label = line.label.trim() || "Tax";
	if (typeof line.rate !== "number" || !Number.isFinite(line.rate) || label.includes("%")) {
		return label;
	}
	const rate = Number(line.rate.toFixed(2));
	return `${label} ${rate}%`;
}

export function taxRows(lines: TaxLineLike[] | undefined, total: Money): TaxRow[] {
	const shown = (lines ?? []).filter((l) => l.amount.amount !== 0);
	if (shown.length > 0) return shown.map((l) => ({ label: taxLineLabel(l), amount: l.amount }));
	return total.amount > 0 ? [{ label: "Tax", amount: total }] : [];
}
