/**
 * PesaLink (Integrated Payment Services Limited - IPSL Kenya) Types
 */

export interface PesalinkCredentials {
	/** Partner / Merchant Client ID */
	apiKey: string;
	/** Partner Secret / HMAC Signing Key */
	secretKey: string;
	/** Kenya Central Bank / IPSL Participant Bank Code (e.g., '01', '11', '03') */
	bankCode: string;
	/** Merchant settlement account number */
	accountNumber: string;
	/** Base URL for PesaLink gateway adapter (default: https://api.pesalink.co.ke) */
	baseUrl?: string;
	/** Webhook HMAC verification secret */
	webhookSecret?: string;
}

export interface PesalinkRoutingInfo {
	bankCode: string;
	accountNumber: string;
	paymentReference: string;
	amount: number; // in KES major units
	accountName?: string;
}

export interface PesalinkWebhookPayload {
	transactionId: string;
	reference: string; // Merchant reference
	pesalinkReference: string; // IPSL core switch trace ID
	amount: number; // Major units KES
	currency: "KES";
	sourceBankCode: string;
	sourceAccountMasked?: string;
	destinationBankCode: string;
	destinationAccount: string;
	status: "SUCCESS" | "FAILED" | "PENDING";
	timestamp: string;
	narrative?: string;
}

export interface PesalinkStatusResponse {
	transactionId: string;
	reference: string;
	pesalinkReference: string;
	amount: number;
	currency: "KES";
	status: "SUCCESS" | "FAILED" | "PENDING";
	message?: string;
}
