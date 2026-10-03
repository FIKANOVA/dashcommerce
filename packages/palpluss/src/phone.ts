/**
 * Kenyan phone number validation and normalization for M-Pesa STK push.
 *
 * Supported formats:
 * - 07XXXXXXXX -> 2547XXXXXXXX
 * - 01XXXXXXXX -> 2541XXXXXXXX
 * - +2547XXXXXXXX -> 2547XXXXXXXX
 * - +2541XXXXXXXX -> 2541XXXXXXXX
 * - 2547XXXXXXXX -> 2547XXXXXXXX
 * - 2541XXXXXXXX -> 2541XXXXXXXX
 */

export function normalizeKenyanPhone(input: string | undefined | null): string {
	if (!input) {
		throw new Error("PalPluss STK requires a customer phone number");
	}

	// Remove whitespace, hyphens, parentheses
	const cleaned = input.replace(/[\s\-\(\)]/g, "");

	// Match patterns
	if (/^(\+?254)(7\d{8}|1\d{8})$/.test(cleaned)) {
		return cleaned.replace(/^\+/, "");
	}

	if (/^0(7\d{8}|1\d{8})$/.test(cleaned)) {
		return `254${cleaned.slice(1)}`;
	}

	throw new Error(
		`Invalid Kenyan phone number for M-Pesa: "${input}". Must be a valid Safaricom/Kenyan mobile number (e.g. 07XXXXXXXX or 01XXXXXXXX).`,
	);
}
