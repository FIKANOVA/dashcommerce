/**
 * Shipping rate calculator.
 *
 * Given a cart + an ordered list of zones, pick the first zone whose
 * locations match the cart's shipping address, then return the list of
 * applicable method rates.
 */

import { REGION_TABLE, regionCode } from "../data/regions";
import { add, money, zero, type Money } from "../money";
import type {
	Address,
	CartLineItem,
	PickupDetails,
	ShippingMethod,
	ShippingRateOption,
	ShippingZone,
} from "../types";

/**
 * How closely a zone matches the address: 0 not at all, 1 on the whole
 * country, 2 on one of the country's regions.
 */
function matchLevel(address: Address, zone: ShippingZone): 0 | 1 | 2 {
	let level: 0 | 1 = 0;
	for (const loc of zone.locations) {
		if (loc.country !== address.country) continue;
		if (!loc.regions || loc.regions.length === 0) level = 1;
		else if (loc.regions.includes(address.region)) return 2;
	}
	return level;
}

export function matchesZone(address: Address, zone: ShippingZone): boolean {
	return matchLevel(address, zone) > 0;
}

/**
 * The first matching zone by `order`. Among matching zones with the same
 * order, one that names the address's region wins over one that covers
 * the whole country, so a "Nairobi" zone works next to a "Kenya" zone
 * even when both are left on the default order.
 */
export function pickZone(
	address: Address,
	zones: ShippingZone[],
): ShippingZone | null {
	const sorted = [...zones].sort((a, b) => a.order - b.order);
	let best: ShippingZone | null = null;
	let bestLevel = 0;
	for (const zone of sorted) {
		if (best && zone.order !== best.order) break;
		const level = matchLevel(address, zone);
		if (level > bestLevel) {
			best = zone;
			bestLevel = level;
		}
	}
	return best;
}

/**
 * The region codes the zones name, by country. Checkout asks for a region
 * only in these countries, and offers only these regions.
 */
export function zoneRegions(zones: ShippingZone[]): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const zone of zones) {
		for (const loc of zone.locations ?? []) {
			for (const region of loc.regions ?? []) {
				const list = (out[loc.country] ??= []);
				if (!list.includes(region)) list.push(region);
			}
		}
	}
	return out;
}

/**
 * The region to keep on a ship-to address, checked against the regions the
 * zones name in its country. A `CC-` prefix is dropped and a known name is
 * turned into its code, so `KE-30` and "Nairobi" both match a zone that
 * names `30`.
 *
 * A region the zones don't name is stored as no region, the same as
 * "Elsewhere" at hosted checkout, rather than refused: it has no rate of its
 * own, so the shopper gets the country-wide rate they would get anyway, and a
 * typed address isn't turned away for a spelling we don't know. A real
 * region the table knows (Mombasa, `28`) is kept as its code, so the address
 * still says where it goes. Countries whose zones name no regions are left
 * as given: there is nothing to check against.
 */
export function checkedRegion(country: string, value: string, zones: ShippingZone[]): string {
	const cc = country.trim().toUpperCase();
	const named = zoneRegions(zones)[cc] ?? [];
	if (named.length === 0) return value.trim();
	const code = regionCode(cc, value);
	const match = named.find((r) => r.toUpperCase() === code.toUpperCase());
	if (match) return match;
	return REGION_TABLE[cc]?.regions.some((r) => r.code === code) ? code : "";
}

function cartSubtotal(items: CartLineItem[], currency: string): Money {
	let total = 0;
	for (const item of items) total += item.lineSubtotal.amount;
	return money(currency, total);
}

function cartWeightGrams(items: CartLineItem[]): number {
	let total = 0;
	for (const item of items) {
		const grams = item.weightGrams ?? 0;
		total += grams * item.quantity;
	}
	return total;
}

/** Copy only the pickup fields that hold text, so an empty method gives `{}`. */
export function pickupDetails(raw: PickupDetails | undefined): PickupDetails {
	const out: PickupDetails = {};
	if (raw?.location) out.location = raw.location;
	if (raw?.instructions) out.instructions = raw.instructions;
	if (raw?.hours) out.hours = raw.hours;
	return out;
}

export interface CalculateRatesInput {
	items: CartLineItem[];
	currency: string;
	methods: ShippingMethod[];
	couponsGiveFreeShipping?: boolean;
}

export function calculateRates(input: CalculateRatesInput): ShippingRateOption[] {
	const subtotal = cartSubtotal(input.items, input.currency);
	const weightGrams = cartWeightGrams(input.items);
	const options: ShippingRateOption[] = [];

	// A method priced in another currency can't be offered: its amount would
	// be added to a cart in a different currency and fail the totals.
	const inCartCurrency = (m: Money | undefined) => !m || m.currency === input.currency;

	for (const method of input.methods) {
		if (!method.enabled) continue;
		const cfg = method.config;

		if (input.couponsGiveFreeShipping) {
			options.push({
				methodId: method.id,
				label: method.title,
				amount: zero(input.currency),
				...(cfg.type === "local_pickup" ? { pickup: pickupDetails(cfg.pickup) } : {}),
			});
			continue;
		}

		if (cfg.type === "flat_rate") {
			if (!inCartCurrency(cfg.amount)) continue;
			options.push({
				methodId: method.id,
				label: method.title,
				amount: cfg.amount,
			});
		} else if (cfg.type === "free_shipping") {
			const min = cfg.minimumAmount;
			if (!inCartCurrency(min)) continue;
			const qualifies = !min || subtotal.amount >= min.amount;
			if (qualifies) {
				options.push({
					methodId: method.id,
					label: method.title,
					amount: zero(input.currency),
				});
			}
		} else if (cfg.type === "local_pickup") {
			if (!inCartCurrency(cfg.amount)) continue;
			options.push({
				methodId: method.id,
				label: method.title,
				amount: cfg.amount ?? zero(input.currency),
				pickup: pickupDetails(cfg.pickup),
			});
		} else if (cfg.type === "weight_based") {
			if (cfg.currency !== input.currency || !inCartCurrency(cfg.base)) continue;
			const variable = money(cfg.currency, Math.round(cfg.perGram * weightGrams));
			options.push({
				methodId: method.id,
				label: method.title,
				amount: add(cfg.base, variable),
			});
		}
	}

	return options;
}
