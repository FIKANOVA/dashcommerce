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
 * - an outward code followed by a space: `SW1 ` or `M5V `. It matches only
 *   postcodes whose outward code (the part before the space) is exactly
 *   that, so `SW1 ` takes SW1 postcodes but not SW10 1AA, which the plain
 *   prefix `SW1` would. Stored with its trailing space.
 *
 * A hyphen between digit groups of different lengths is part of a postcode,
 * not a range: `1000-001` is a full Portuguese postcode, matched as a prefix.
 *
 * Postcodes compare without case or spaces, the same way tax rates match
 * them (`normalisePostalCode`), except for the outward-code check above.
 */

import { normalisePostalCode } from "../tax/calculate";

/** Longest postcode entry or shopper postcode we accept. */
export const POSTCODE_MAX_LENGTH = 16;
/** Most postcode entries one zone location may list. */
export const POSTCODE_MAX_ENTRIES = 500;

const RANGE = /^(\d+)-(\d+)$/;
const ENTRY = /^[A-Z0-9-]+$/;
/** Letters and digits with a letter among them, e.g. `SW1`, `EC1A`, `M5V`. */
const OUTWARD = /^(?=[A-Z0-9]*[A-Z])[A-Z0-9]+$/;

/** Whether a stored entry is an exact outward code (`SW1 `). */
function isOutwardEntry(entry: string): boolean {
	return entry.endsWith(" ");
}

/**
 * The outward code of a shopper's postcode: the part before the space, or,
 * typed without a space, all but the last three characters (the inward code
 * in UK and Canadian postcodes). Four characters or fewer are taken whole.
 */
function outwardCode(postalCode: string): string {
	const spaced = postalCode.trim().toUpperCase().replace(/\s+/g, " ");
	const space = spaced.indexOf(" ");
	if (space > 0) return spaced.slice(0, space);
	return spaced.length >= 5 ? spaced.slice(0, -3) : spaced;
}

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
	// `SW1 `: an outward code with a trailing space matches that code only.
	const outward = raw.trimStart();
	if (/\s$/.test(outward) && OUTWARD.test(outward.trim().toUpperCase())) {
		const code = outward.trim().toUpperCase();
		if (code.length > POSTCODE_MAX_LENGTH) {
			return {
				ok: false,
				error: `postcode '${raw.trim()}' is longer than ${POSTCODE_MAX_LENGTH} characters`,
			};
		}
		return { ok: true, value: `${code} ` };
	}
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
		if (isOutwardEntry(entry)) {
			if (outwardCode(postalCode ?? "") === entry.trimEnd()) return true;
			continue;
		}
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
