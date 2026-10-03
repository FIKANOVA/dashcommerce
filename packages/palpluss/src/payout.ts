import { PalplussClient } from "./client";
import { normalizeKenyanPhone } from "./phone";
import type {
	PalplussB2CPayoutInput,
	PalplussB2CPayoutResult,
	PalplussCredentials,
} from "./types";

export interface PayoutRuntimeContext {
	http?: {
		fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
	};
}

/**
 * PalPluss B2C Payout Service.
 *
 * Dedicated out-of-band payout rail to send funds to an M-Pesa phone number from
 * a pre-funded B2C utility/service wallet.
 *
 * Important safeguards:
 * - Requires explicit idempotent `payoutRequestId`.
 * - Requires phone number validation against Safaricom formats.
 * - Does not perform automatic debits from bank accounts.
 * - Not an automatic replacement for refunds or split settlement.
 */
export class PalplussPayoutService {
	private readonly credentials: PalplussCredentials;

	constructor(credentials: PalplussCredentials) {
		if (!credentials.channelId) {
			throw new Error("PalPluss B2C payout requires a configured channelId");
		}
		if (!credentials.apiKey) {
			throw new Error("PalPluss B2C payout requires an apiKey");
		}
		this.credentials = credentials;
	}

	async executePayout(
		input: PalplussB2CPayoutInput,
		ctx?: PayoutRuntimeContext,
	): Promise<PalplussB2CPayoutResult> {
		if (!input.payoutRequestId || typeof input.payoutRequestId !== "string") {
			throw new Error("payoutRequestId is required for B2C payout idempotency");
		}

		if (
			typeof input.amountMinor !== "number" ||
			!Number.isInteger(input.amountMinor) ||
			input.amountMinor <= 0
		) {
			throw new Error("amountMinor must be a positive integer in minor units");
		}

		const phone = normalizeKenyanPhone(input.phoneNumber);

		const client = new PalplussClient(this.credentials, ctx?.http);
		return client.initiateB2CPayout({
			...input,
			phoneNumber: phone,
			channelId: input.channelId || this.credentials.channelId,
		});
	}
}
