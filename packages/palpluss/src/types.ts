/**
 * Types and interfaces for the PalPluss payment provider.
 */

export interface PalplussCredentials {
	/** API key / client ID */
	apiKey: string;
	/** API secret key (if using basic auth pair) */
	secretKey?: string;
	/** Configured merchant channel ID / paybill / till channel */
	channelId: string;
	/**
	 * Authentication scheme to use in Authorization header:
	 * - "basic_base64": Basic base64(apiKey:secretKey) or base64(apiKey)
	 * - "basic_raw": Basic raw apiKey (observed in some legacy PalPluss docs)
	 * - "bearer": Bearer apiKey
	 * Default: "basic_base64" if secretKey is present, otherwise "bearer".
	 */
	authScheme?: "basic_base64" | "basic_raw" | "bearer";
	/** Base URL for PalPluss API (default: https://api.palpluss.com) */
	baseUrl?: string;
	/** Allowlisted HTTPS callback URL */
	callbackUrl?: string;
	/** Optional HMAC secret if a signed webhook header is provisioned */
	webhookSecret?: string;
}

export interface PalplussStkInitiateRequest {
	phoneNumber: string;
	amount: number; // in KES major units
	accountReference: string; // <= 12 characters
	description: string; // <= 13 characters
	channelId: string;
	callbackUrl: string;
}

export interface PalplussStkInitiateResponse {
	status: "PENDING" | "SUCCESS" | "FAILED";
	transactionId: string;
	checkoutReference?: string;
	message?: string;
	raw?: unknown;
}

export interface PalplussTransactionStatusResponse {
	transactionId: string;
	reference: string;
	status: "SUCCESS" | "FAILED" | "CANCELLED" | "EXPIRED" | "PENDING";
	amount: number; // in KES major units
	currency: "KES";
	channelId: string;
	mpesaReceipt?: string;
	phoneNumber?: string;
	failureReason?: string;
	raw?: unknown;
}

export interface PalplussB2CPayoutInput {
	/** Scoped operation idempotency key */
	payoutRequestId: string;
	/** Recipient Safaricom M-Pesa phone number */
	phoneNumber: string;
	/** Minor units integer amount (e.g. 100000 = 1000 KES) */
	amountMinor: number;
	/** Channel ID with funded B2C wallet */
	channelId: string;
	/** Optional remarks (e.g. "Refund voucher" or "Vendor settlement") */
	remarks?: string;
}

export interface PalplussB2CPayoutResult {
	payoutRequestId: string;
	transactionId?: string;
	status: "pending" | "succeeded" | "failed";
	amountMinor: number;
	currency: "KES";
	recipientPhone: string;
	reason?: string;
	raw?: unknown;
}
