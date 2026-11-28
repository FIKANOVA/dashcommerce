/**
 * Shipping rate calculator.
 *
 * Given a cart + an ordered list of zones, pick the first zone whose
 * locations match the cart's shipping address, then return the list of
 * applicable method rates.
 */

import { REGION_TABLE, regionCode } from "../data/regions";
import { add, money, zero, type Money } from "../money";
import { areaKey, areaMatches } from "./areas";
import { postcodeMatches } from "./postcodes";
import type {
	Address,
	CartLineItem,
	PickupDetails,
	ShippingMethod,
	ShippingRateOption,
	ShippingZone,
} from "../types";

/** Why a zone matched an address, from the closest match down. */
export type ZoneMatchReason = "area" | "postcode" | "region" | "country";

const REASONS: readonly ZoneMatchReason[] = ["country", "region", "postcode", "area"];

/**
 * How closely a zone matches the address: 0 not at all, 1 on the whole
 * country, 2 on one of the country's regions, 3 on its postcode, 4 on its
 * area (the address's `city`). A location that lists postcodes matches only
 * an address whose postcode is one of them, one that lists areas only an
 * address in one of them, and one that lists regions only an address in
 * one of those; a location listing several needs all of them to match.
 */
function matchLevel(address: Address, zone: ShippingZone): 0 | 1 | 2 | 3 | 4 {
	let level: 0 | 1 | 2 | 3 | 4 = 0;
	for (const loc of zone.locations) {
		if (loc.country !== address.country) continue;
		const regions = loc.regions ?? [];
		const postcodes = loc.postcodes ?? [];
		const areas = loc.areas ?? [];
		if (regions.length > 0 && !regions.includes(address.region)) continue;
		if (postcodes.length > 0 && !postcodeMatches(address.postalCode, postcodes)) continue;
		if (areas.length > 0 && !areaMatches(address.city, areas)) continue;
		const here =
			areas.length > 0 ? 4 : postcodes.length > 0 ? 3 : regions.length > 0 ? 2 : 1;
		if (here > level) level = here;
	}
	return level;
}

export function matchesZone(address: Address, zone: ShippingZone): boolean {
	return matchLevel(address, zone) > 0;
}

/**
 * The zone checkout uses for the address, and why it matched. Zones are
 * tried by `order`, lowest first. Among matching zones with the same order,
 * one that names the address's area wins over one that names its postcode,
 * which wins over one that names its region, which wins over one that
 * covers the whole country, so a "Westlands" zone works next to a
 * "Nairobi" zone and a "Kenya" zone even when all are left on the default
 * order.
 */
export function matchZone(
	address: Address,
	zones: ShippingZone[],
): { zone: ShippingZone; reason: ZoneMatchReason } | null {
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
	const reason = REASONS[bestLevel - 1];
	return best && reason ? { zone: best, reason } : null;
}

/**
 * The enabled methods an address is offered: those of the zone it matches
 * (see `matchZone`), then the local pickup methods of any other zone that
 * covers it, so pickup set on a country-wide zone stays on offer when a
 * town or postcode zone sets the delivery rate. Storage may hold `enabled`
 * as 1.
 */
export function methodsForAddress(
	address: Address,
	zones: ShippingZone[],
	methods: ShippingMethod[],
): { zone: ShippingZone; reason: ZoneMatchReason; methods: ShippingMethod[] } | null {
	const match = matchZone(address, zones);
	if (!match) return null;
	const enabled = (m: ShippingMethod) => m.enabled === true || (m.enabled as unknown) === 1;
	const own = methods.filter((m) => m.zoneId === match.zone.id && enabled(m));
	const otherZones = new Set(
		zones.filter((z) => z.id !== match.zone.id && matchesZone(address, z)).map((z) => z.id),
	);
	const pickups = methods.filter(
		(m) => otherZones.has(m.zoneId) && enabled(m) && m.config.type === "local_pickup",
	);
	return { ...match, methods: [...own, ...pickups] };
}

/** The zone checkout uses for the address (see `matchZone`). */
export function pickZone(
	address: Address,
	zones: ShippingZone[],
): ShippingZone | null {
	return matchZone(address, zones)?.zone ?? null;
}

/** The countries the zones list, sorted by code. */
export function zoneCountries(zones: ShippingZone[]): string[] {
	const out = new Set<string>();
	for (const zone of zones) {
		for (const loc of zone.locations ?? []) out.add(loc.country);
	}
	return [...out].sort();
}

/**
 * The areas the zones list, by country: `country` holds those on locations
 * that name no region, and `regions` those on locations that do, by region
 * code. Each list keeps an area once (by `areaKey`) and is sorted by name.
 * Countries without areas are left out.
 */
export function zoneAreas(
	zones: ShippingZone[],
): Record<string, { country: string[]; regions: Record<string, string[]> }> {
	const out: Record<string, { country: string[]; regions: Record<string, string[]> }> = {};
	const addTo = (list: string[], area: string) => {
		if (!list.some((a) => areaKey(a) === areaKey(area))) list.push(area);
	};
	for (const zone of zones) {
		for (const loc of zone.locations ?? []) {
			if (!loc.areas || loc.areas.length === 0) continue;
			const entry = (out[loc.country] ??= { country: [], regions: {} });
			const regions = loc.regions ?? [];
			for (const area of loc.areas) {
				if (regions.length === 0) addTo(entry.country, area);
				for (const region of regions) addTo((entry.regions[region] ??= []), area);
			}
		}
	}
	const byName = (a: string, b: string) => a.localeCompare(b);
	for (const entry of Object.values(out)) {
		entry.country.sort(byName);
		for (const list of Object.values(entry.regions)) list.sort(byName);
	}
	return out;
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
 * The countries where a zone lists postcodes. Checkout asks for the
 * postcode before quoting only in these countries.
 */
export function zonePostcodeCountries(zones: ShippingZone[]): string[] {
	const out = new Set<string>();
	for (const zone of zones) {
		for (const loc of zone.locations ?? []) {
			if (loc.postcodes && loc.postcodes.length > 0) out.add(loc.country);
		}
	}
	return [...out].sort();
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
