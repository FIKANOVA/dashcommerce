import type {
	PalplussB2CPayoutInput,
	PalplussB2CPayoutResult,
	PalplussCredentials,
	PalplussStkInitiateRequest,
	PalplussStkInitiateResponse,
	PalplussTransactionStatusResponse,
} from "./types";

export interface HttpClient {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export class PalplussClient {
	private readonly baseUrl: string;
	private readonly credentials: PalplussCredentials;
	private readonly http: HttpClient;

	constructor(credentials: PalplussCredentials, http?: HttpClient) {
		this.credentials = credentials;
		this.baseUrl = (credentials.baseUrl || "https://api.palpluss.com").replace(
			/\/+$/,
			"",
		);
		this.http = http || { fetch: globalThis.fetch.bind(globalThis) };
	}

	/**
	 * Compute the Authorization header according to the configured scheme.
	 *
	 * Note: PalPluss documentation exhibits variations between Bearer token,
	 * base64-encoded Basic auth, and raw Basic auth. This client records and
	 * respects the exact configured scheme without silent falling-back retries.
	 */
	private getAuthHeader(): string {
		const scheme =
			this.credentials.authScheme ||
			(this.credentials.secretKey ? "basic_base64" : "bearer");

		if (scheme === "bearer") {
			return `Bearer ${this.credentials.apiKey.trim()}`;
		}

		if (scheme === "basic_raw") {
			return `Basic ${this.credentials.apiKey.trim()}`;
		}

		// basic_base64
		const raw = this.credentials.secretKey
			? `${this.credentials.apiKey.trim()}:${this.credentials.secretKey.trim()}`
			: this.credentials.apiKey.trim();
		const encoded =
			typeof btoa === "function"
				? btoa(raw)
				: Buffer.from(raw, "utf-8").toString("base64");
		return `Basic ${encoded}`;
	}

	async initiateStk(
		request: PalplussStkInitiateRequest,
	): Promise<PalplussStkInitiateResponse> {
		const url = `${this.baseUrl}/v1/payments/stk`;
		const res = await this.http.fetch(url, {
			method: "POST",
			headers: {
				Authorization: this.getAuthHeader(),
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				phoneNumber: request.phoneNumber,
				amount: request.amount,
				accountReference: request.accountReference,
				description: request.description,
				channelId: request.channelId,
				callbackUrl: request.callbackUrl,
			}),
		});

		const text = await res.text();
		let data: any = {};
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(
				`PalPluss STK initiate returned unparseable response (HTTP ${res.status}): ${text.slice(0, 100)}`,
			);
		}

		if (!res.ok) {
			const msg =
				data.message ||
				data.error ||
				`HTTP ${res.status} error during PalPluss STK initiation`;
			throw new Error(`PalPluss STK initiate failed: ${msg}`);
		}

		const transactionId =
			data.transactionId || data.reference || data.id || data.checkoutRequestID;
		if (!transactionId) {
			throw new Error(
				"PalPluss STK initiate succeeded but response missing transaction ID",
			);
		}

		return {
			status: data.status === "FAILED" ? "FAILED" : "PENDING",
			transactionId: String(transactionId),
			checkoutReference: String(transactionId),
			message: data.message,
			raw: data,
		};
	}

	async getTransactionStatus(
		reference: string,
	): Promise<PalplussTransactionStatusResponse> {
		const url = `${this.baseUrl}/v1/payments/${encodeURIComponent(reference)}`;
		const res = await this.http.fetch(url, {
			method: "GET",
			headers: {
				Authorization: this.getAuthHeader(),
				Accept: "application/json",
			},
		});

		const text = await res.text();
		let data: any = {};
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(
				`PalPluss status lookup returned unparseable response (HTTP ${res.status}): ${text.slice(0, 100)}`,
			);
		}

		if (!res.ok) {
			const msg =
				data.message ||
				data.error ||
				`HTTP ${res.status} error during PalPluss status lookup`;
			throw new Error(`PalPluss status lookup failed: ${msg}`);
		}

		const statusRaw = String(data.status || "PENDING").toUpperCase();
		let status: PalplussTransactionStatusResponse["status"] = "PENDING";
		if (statusRaw === "SUCCESS" || statusRaw === "PAID") {
			status = "SUCCESS";
		} else if (statusRaw === "FAILED") {
			status = "FAILED";
		} else if (statusRaw === "CANCELLED") {
			status = "CANCELLED";
		} else if (statusRaw === "EXPIRED") {
			status = "EXPIRED";
		}

		return {
			transactionId: String(data.transactionId || reference),
			reference: String(data.reference || reference),
			status,
			amount: Number(data.amount || 0),
			currency: "KES",
			channelId: String(data.channelId || this.credentials.channelId),
			mpesaReceipt:
				data.mpesaReceipt || data.receiptNumber || data.mpesaReceiptNumber,
			phoneNumber: data.phoneNumber,
			failureReason: data.failureReason || data.message,
			raw: data,
		};
	}

	async initiateB2CPayout(
		input: PalplussB2CPayoutInput,
	): Promise<PalplussB2CPayoutResult> {
		const url = `${this.baseUrl}/v1/b2c/payout`;
		const amountKes = input.amountMinor / 100;

		const res = await this.http.fetch(url, {
			method: "POST",
			headers: {
				Authorization: this.getAuthHeader(),
				"Content-Type": "application/json",
				Accept: "application/json",
				"X-Idempotency-Key": input.payoutRequestId,
			},
			body: JSON.stringify({
				phoneNumber: input.phoneNumber,
				amount: amountKes,
				channelId: input.channelId,
				remarks: input.remarks || "B2C Payout",
				correlationId: input.payoutRequestId,
			}),
		});

		const text = await res.text();
		let data: any = {};
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(
				`PalPluss B2C payout returned unparseable response (HTTP ${res.status}): ${text.slice(0, 100)}`,
			);
		}

		if (!res.ok) {
			const reason =
				data.message ||
				data.error ||
				`HTTP ${res.status} error during PalPluss B2C payout`;
			return {
				payoutRequestId: input.payoutRequestId,
				status: "failed",
				amountMinor: input.amountMinor,
				currency: "KES",
				recipientPhone: input.phoneNumber,
				reason,
				raw: data,
			};
		}

		return {
			payoutRequestId: input.payoutRequestId,
			transactionId: data.transactionId || data.id,
			status: data.status === "SUCCESS" ? "succeeded" : "pending",
			amountMinor: input.amountMinor,
			currency: "KES",
			recipientPhone: input.phoneNumber,
			raw: data,
		};
	}
}
