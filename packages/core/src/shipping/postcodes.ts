/**
 * Postcodes on shipping zone locations, so a shop can charge a city rate
 * (Lisbon's 1000–1999 in Portugal, Nairobi's 00100 in Kenya) next to a
 * country-wide one.
 *
 * Each entry is one of:
 * - a prefix: `1`, `00100`, `SW1`, or `SW1*` (the `*` is dropped);
 * - an inclusive range of digits with ends of the same length: `1000-1999`.
 *   It compares the first digits of the postcode, as many as the ends have,
 *   numerically, so `1100-148` (Lisbon) falls in `1000-1999`.
 *
 * A hyphen between digit groups of different lengths is part of a postcode,
 * not a range: `1000-001` is a full Portuguese postcode, matched as a prefix.
 *
 * Postcodes compare without case or spaces, the same way tax rates match
 * them (`normalisePostalCode`).
 */

import { normalisePostalCode } from "../tax/calculate";

/** Longest postcode entry or shopper postcode we accept. */
export const POSTCODE_MAX_LENGTH = 16;
/** Most postcode entries one zone location may list. */
export const POSTCODE_MAX_ENTRIES = 500;

const RANGE = /^(\d+)-(\d+)$/;
const ENTRY = /^[A-Z0-9-]+$/;

/** A same-length digit range, or null when the entry is a prefix. */
function asRange(entry: string): { start: string; end: string } | null {
	const [, start, end] = RANGE.exec(entry) ?? [];
	if (start === undefined || end === undefined || start.length !== end.length) return null;
	return { start, end };
}

/**
 * The entry as it is stored, or an error to show the merchant. Case and
 * spaces are dropped and a trailing `*` becomes a plain prefix.
 */
export function parsePostcodeEntry(
	raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
	let entry = normalisePostalCode(raw);
	if (entry.endsWith("*")) entry = entry.slice(0, -1);
	if (entry === "") return { ok: false, error: `'${raw.trim()}' is not a postcode` };
	if (entry.length > POSTCODE_MAX_LENGTH * 2 + 1 || !ENTRY.test(entry)) {
		return {
			ok: false,
			error: `'${raw.trim()}' is not a postcode, prefix or range (use letters, digits and hyphens, e.g. 00100, SW1 or 1000-1999)`,
		};
	}
	const range = asRange(entry);
	if (range) {
		if (range.start > range.end) {
			return {
				ok: false,
				error: `postcode range '${raw.trim()}' starts after it ends`,
			};
		}
		return { ok: true, value: entry };
	}
	if (entry.length > POSTCODE_MAX_LENGTH) {
		return {
			ok: false,
			error: `postcode '${raw.trim()}' is longer than ${POSTCODE_MAX_LENGTH} characters`,
		};
	}
	if (entry.startsWith("-") || entry.endsWith("-") || entry.includes("--")) {
		return { ok: false, error: `'${raw.trim()}' is not a postcode, prefix or range` };
	}
	return { ok: true, value: entry };
}

/** Whether the shopper's postcode matches one of the entries. No postcode matches none. */
export function postcodeMatches(
	postalCode: string | undefined,
	entries: readonly string[],
): boolean {
	const code = normalisePostalCode(postalCode);
	if (!code) return false;
	for (const entry of entries) {
		const range = asRange(entry);
		if (range) {
			const head = code.slice(0, range.start.length);
			if (head.length !== range.start.length || !/^\d+$/.test(head)) continue;
			// Same-length digit strings sort the same as their numbers.
			if (head >= range.start && head <= range.end) return true;
		} else if (code.startsWith(entry)) {
			return true;
		}
	}
	return false;
}

/**
 * Whether a postcode typed at checkout is short, sane text. An empty
 * postcode is fine: many addresses have none.
 */
export function isPlausiblePostcode(value: string): boolean {
	return value.length <= POSTCODE_MAX_LENGTH && /^[A-Za-z0-9 -]*$/.test(value);
}
