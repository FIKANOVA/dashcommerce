import type { PosTenderLine, PosTenderType } from "../types";

export interface ValidateTendersInput {
	saleTotal: number; // minor units
	currency: string;
	tenders: PosTenderLine[];
	isOnline: boolean;
	allowDraft?: boolean;
}

export interface ValidateTendersResult {
	valid: boolean;
	status: "completed" | "draft";
	totalTendered: number;
	changeDue: number;
	errors: string[];
}

export function validatePosTenders(
	input: ValidateTendersInput,
): ValidateTendersResult {
	const errors: string[] = [];
	const normCurrency = input.currency.trim().toUpperCase();

	if (!input.tenders || input.tenders.length === 0) {
		return {
			valid: false,
			status: "draft",
			totalTendered: 0,
			changeDue: 0,
			errors: ["At least one tender line is required"],
		};
	}

	let totalTendered = 0;
	let hasCash = false;
	let hasElectronic = false;
	let hasUnverifiedElectronic = false;

	for (const t of input.tenders) {
		if (t.currency.trim().toUpperCase() !== normCurrency) {
			errors.push(
				`Tender currency mismatch: tender has ${t.currency}, sale total is in ${normCurrency}`,
			);
		}

		if (typeof t.amount !== "number" || !Number.isInteger(t.amount) || t.amount <= 0) {
			errors.push(`Tender line ${t.id} amount must be a positive integer`);
			continue;
		}

		totalTendered += t.amount;

		if (t.type === "cash") {
			hasCash = true;
		} else {
			hasElectronic = true;
			// Card terminal requires an external reference and confirmation
			if (t.type === "card_terminal") {
				if (!t.externalReference || !t.externalReference.trim()) {
					errors.push("card_terminal tender requires an external terminal reference");
				}
				if (!t.verified) {
					hasUnverifiedElectronic = true;
				}
			}

			// M-Pesa STK push requires online verification to complete sale
			if (t.type === "mpesa_stk") {
				if (!input.isOnline && !t.verified) {
					hasUnverifiedElectronic = true;
				} else if (!t.verified) {
					hasUnverifiedElectronic = true;
				}
			}

			// M-Pesa QR requires verified server reconciliation
			if (t.type === "mpesa_qr" && !t.verified) {
				hasUnverifiedElectronic = true;
			}
		}
	}

	// Change calculation (only cash allows overpayment)
	let changeDue = 0;
	if (totalTendered > input.saleTotal) {
		if (!hasCash) {
			errors.push(
				"Overpayment is only permitted on cash tender. Electronic tenders must match the required amount.",
			);
		} else {
			changeDue = totalTendered - input.saleTotal;
		}
	} else if (totalTendered < input.saleTotal) {
		errors.push(
			`Underpaid tender: tendered ${totalTendered} but total sale is ${input.saleTotal}`,
		);
	}

	// Split tender rule: Never complete a mixed/split sale while its electronic tender is unverified!
	if (hasElectronic && hasUnverifiedElectronic) {
		if (input.allowDraft) {
			return {
				valid: true,
				status: "draft",
				totalTendered,
				changeDue: 0,
				errors: [],
			};
		}
		errors.push(
			"Cannot complete sale: electronic tender is unverified. Online verification required or save as draft.",
		);
	}

	if (errors.length > 0) {
		return {
			valid: false,
			status: "draft",
			totalTendered,
			changeDue,
			errors,
		};
	}

	return {
		valid: true,
		status: "completed",
		totalTendered,
		changeDue,
		errors: [],
	};
}
