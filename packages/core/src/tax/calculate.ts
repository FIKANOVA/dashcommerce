/**
 * Tax — flat & table implementations.
 *
 * `flat` is a single percentage read from plugin settings.
 * `table` looks up rates by country/region/postal code match, descending
 * priority, respecting tax class. A rate limited to a region or postcode
 * only applies when the address has that region or postcode.
 *
 * Stripe Tax path is invoked during Payment Intent creation in Phase 5 —
 * not here — because it consumes a PaymentIntent id.
 */

import type { PricingPolicy } from "../cart/calculate";
import { percent as pct, type Money } from "../money";
import type { CountryCode, TaxLine, TaxRate } from "../types";

/** The tax class every cart line is taxed under until lines carry their own. */
export const STANDARD_TAX_CLASS = "standard";

export interface TableLookup {
	country: CountryCode;
	region?: string;
	postalCode?: string;
	taxClass: string;
}

export function selectApplicableRates(
	rates: TaxRate[],
	lookup: TableLookup,
): TaxRate[] {
	const matches = rates.filter((r) => {
		if (r.country !== lookup.country) return false;
		if (r.region && r.region !== lookup.region) return false;
		if (r.postalCode) {
			const postalCode = normalisePostalCode(lookup.postalCode);
			if (!postalCode || !postalCode.startsWith(normalisePostalCode(r.postalCode))) return false;
		}
		if (r.taxClass !== lookup.taxClass) return false;
		return true;
	});
	return matches.sort((a, b) => a.priority - b.priority);
}

/** Postcodes compare without case or spaces: "sw1a 1aa" matches a "SW1A" rate. */
function normalisePostalCode(value: string | undefined): string {
	return (value ?? "").replace(/\s+/g, "").toUpperCase();
}

/**
 * Table-mode resolver for `recalculate`: the shop's rates matched against
 * the cart's address. No address (or no country) yet means no tax lines;
 * they appear once the customer says where the order goes.
 */
export function tableTaxResolver(rates: TaxRate[]): NonNullable<PricingPolicy["taxResolver"]> {
	return ({ base, address }) => {
		if (!address?.country) return [];
		const applicable = selectApplicableRates(rates, {
			country: address.country,
			region: address.region || undefined,
			postalCode: address.postalCode || undefined,
			taxClass: STANDARD_TAX_CLASS,
		});
		return tableTaxLines(base, applicable);
	};
}

export function tableTaxLines(base: Money, rates: TaxRate[]): TaxLine[] {
	const lines: TaxLine[] = [];
	let runningBase = base;
	for (const r of rates) {
		const applicable = r.compound ? runningBase : base;
		const amount = pct(applicable, r.rate);
		lines.push({ label: r.name, amount, rate: r.rate });
		if (r.compound) {
			// accumulate into base for subsequent compounds
			runningBase = { ...runningBase, amount: runningBase.amount + amount.amount };
		}
	}
	return lines;
}
