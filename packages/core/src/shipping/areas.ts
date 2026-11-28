/**
 * Delivery areas on shipping zone locations: the towns, districts or
 * estates a merchant delivers to (Westlands and Kilimani in Nairobi, Lekki
 * in Lagos, Dubai Marina in Dubai). Many places have no postcodes people
 * use, so an area is how shoppers there say where they are.
 *
 * The shopper's area is stored as the address's `city`. Areas compare
 * without case, accents or extra spaces, so "westlands", "Westlands " and
 * "WESTLANDS" are one area, and so are "Málaga" and "Malaga".
 */

/** Longest area name a merchant or shopper may give. */
export const AREA_MAX_LENGTH = 80;
/** Most areas one zone location may list. */
export const AREA_MAX_ENTRIES = 200;

/** Control characters and the characters that start markup. */
const UNSAFE = /[\p{Cc}\p{Cf}<>]/u;

/** The key two area names compare by. */
export function areaKey(value: string | undefined): string {
	return (typeof value === "string" ? value : "")
		.normalize("NFD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

/** Whether the address's area (its `city`) is one of the listed areas. No area matches none. */
export function areaMatches(city: string | undefined, areas: readonly string[]): boolean {
	const key = areaKey(city);
	if (!key) return false;
	return areas.some((area) => areaKey(area) === key);
}

/** An area name as stored: trimmed, with runs of spaces made one. */
export function tidyArea(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/**
 * Why an area name is refused, or null when it is fine: plain text of at
 * most `AREA_MAX_LENGTH` characters, with no markup or control characters.
 * Checked before tidying, so a tab or newline inside a name is refused.
 */
export function areaError(value: string): string | null {
	if (UNSAFE.test(value.trim())) {
		return "must be plain text, without < > or control characters";
	}
	if (tidyArea(value).length > AREA_MAX_LENGTH) {
		return `must be at most ${AREA_MAX_LENGTH} characters`;
	}
	return null;
}

/**
 * A location's areas for storage, or the reason they are refused. Names
 * are tidied, empty ones dropped and repeats (by `areaKey`) kept once.
 */
export function parseAreaList(
	input: unknown,
): { ok: true; value: string[] } | { ok: false; error: string } {
	if (!Array.isArray(input) || input.some((a) => typeof a !== "string")) {
		return { ok: false, error: "areas must be an array of strings" };
	}
	const out: string[] = [];
	const seen = new Set<string>();
	for (const raw of input as string[]) {
		const error = areaError(raw);
		if (error) return { ok: false, error: `area '${tidyArea(raw).slice(0, 40)}' ${error}` };
		const name = tidyArea(raw);
		const key = areaKey(name);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(name);
	}
	if (out.length > AREA_MAX_ENTRIES) {
		return { ok: false, error: `list at most ${AREA_MAX_ENTRIES} areas per country` };
	}
	return { ok: true, value: out };
}
