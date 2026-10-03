import type { PosLineItem, PosOperatorSession, PosStockAllocation } from "../types";

export class AllocationExhaustedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AllocationExhaustedError";
	}
}

export class OperatorAuthorizationExpiredError extends Error {
	constructor(message = "Offline operator session has expired") {
		super(message);
		this.name = "OperatorAuthorizationExpiredError";
	}
}

export interface CheckAllocationInput {
	lines: PosLineItem[];
	session: PosOperatorSession;
	getAllocation: (
		productId: string,
		variantId?: string,
	) => Promise<PosStockAllocation | null>;
}

export interface CheckAllocationResult {
	allowed: boolean;
	allowAsDraftOnly: boolean;
	reason?: string;
}

export async function checkOfflineSaleEligibility(
	input: CheckAllocationInput,
): Promise<CheckAllocationResult> {
	const now = new Date();

	// 1. Verify operator session authorization
	const sessionExpires = new Date(input.session.expiresAt);
	if (now >= sessionExpires) {
		return {
			allowed: false,
			allowAsDraftOnly: true,
			reason: "Operator offline session has expired; only draft sales allowed.",
		};
	}

	// 2. Verify stock allocations for tracked line items
	for (const line of input.lines) {
		const alloc = await input.getAllocation(line.productId, line.variantId);
		if (!alloc) {
			return {
				allowed: false,
				allowAsDraftOnly: true,
				reason: `No stock allocation found on this device for product "${line.title}".`,
			};
		}

		const allocExpires = new Date(alloc.expiresAt);
		if (now >= allocExpires) {
			return {
				allowed: false,
				allowAsDraftOnly: true,
				reason: `Stock allocation for product "${line.title}" expired at ${alloc.expiresAt}.`,
			};
		}

		const available = alloc.allocatedQuantity - alloc.soldQuantity;
		if (line.quantity > available) {
			return {
				allowed: false,
				allowAsDraftOnly: true,
				reason: `Insufficient local device stock for "${line.title}": requested ${line.quantity}, available ${available}.`,
			};
		}
	}

	return {
		allowed: true,
		allowAsDraftOnly: false,
	};
}
