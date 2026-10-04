/**
 * PesalinkPaymentProvider — PesaLink (IPSL Kenya interbank rails) implementing
 * @dashcommerce/core's PaymentProvider interface.
 */

import type {
	CreateRefundInput,
	EventIdSource,
	InitCheckoutInput,
	InitCheckoutResult,
	Money,
	NormalizedPaymentEvent,
	PaymentProvider,
	PaymentProviderCredentials,
	PaymentProviderRuntimeContext,
	RefundResult,
	VerifyWebhookInput,
	VerifyWebhookResult,
} from "@dashcommerce/core/payment-provider";
import type {
	PesalinkCredentials,
	PesalinkStatusResponse,
	PesalinkWebhookPayload,
} from "./types";

export interface PesalinkProviderOptions {
	baseUrl?: string;
	bankName?: string;
	accountName?: string;
}

export class PesalinkPaymentProvider implements PaymentProvider {
	readonly id = "pesalink";
	readonly label = "PesaLink (Interbank)";

	constructor(private readonly options: PesalinkProviderOptions = {}) {}

	supportsCurrency(currency: string): boolean {
		if (typeof currency !== "string") return false;
		return currency.trim().toUpperCase() === "KES";
	}

	formatAmount(money: Money): string {
		const major = (money.amount / 100).toLocaleString("en-KE", {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		});
		return `${money.currency.toUpperCase()} ${major}`;
	}

	private resolveCredentials(
		credentials: PaymentProviderCredentials,
	): PesalinkCredentials {
		const raw = credentials as Record<string, unknown>;
		return {
			apiKey: String(raw.apiKey ?? "").trim(),
			secretKey: String(raw.secretKey ?? "").trim(),
			bankCode: String(raw.channelId ?? "01").trim(),
			accountNumber: String(raw.accountNumber ?? "1100000000").trim(),
			baseUrl: raw.baseUrl ? String(raw.baseUrl) : (this.options.baseUrl || "https://api.pesalink.co.ke"),
			webhookSecret: raw.webhookSecret ? String(raw.webhookSecret) : undefined,
		};
	}

	async initCheckout(
		_ctx: PaymentProviderRuntimeContext,
		input: InitCheckoutInput,
		credentials: PaymentProviderCredentials,
	): Promise<InitCheckoutResult> {
		const normCurrency = input.currency.trim().toUpperCase();
		if (!this.supportsCurrency(normCurrency)) {
			throw new Error(`PesaLink only supports KES, received: ${input.currency}`);
		}

		const creds = this.resolveCredentials(credentials);
		const amountMajor = input.amount / 100;

		// Generate IPSL-compatible reference: 6-12 uppercase alphanumeric
		const pesalinkRef = `PLK-${input.orderDraftId.slice(-8).toUpperCase()}`;

		return {
			kind: "pending",
			status: "pending",
			checkoutReference: input.orderDraftId,
			providerReference: pesalinkRef,
		};
	}

	async verifyWebhook(
		input: VerifyWebhookInput,
	): Promise<VerifyWebhookResult> {
		let body: Record<string, unknown> = {};
		if (typeof input.rawBody === "string") {
			try {
				body = JSON.parse(input.rawBody);
			} catch {
				return { ok: false, reason: "Malformed JSON payload" };
			}
		}

		if (!body.pesalinkReference && !body.transactionId) {
			return { ok: false, reason: "Missing PesaLink trace reference" };
		}

		return { ok: true };
	}

	parseWebhookEvent(rawBody: string): NormalizedPaymentEvent {
		let payload: Partial<PesalinkWebhookPayload> = {};
		if (typeof rawBody === "string") {
			try {
				payload = JSON.parse(rawBody);
			} catch {
				return {
					type: "unhandled",
					providerEventType: "unparseable",
					raw: rawBody,
				};
			}
		}

		const pesalinkRef = payload.pesalinkReference || payload.transactionId;
		if (!pesalinkRef) {
			return {
				type: "unhandled",
				providerEventType: "missing_reference",
				raw: payload,
			};
		}

		const amountMinor = Math.round((payload.amount || 0) * 100);
		const eventIdSource: EventIdSource = "native";
		const providerEventId = `pesalink:${pesalinkRef}`;

		if (payload.status === "SUCCESS") {
			return {
				type: "charge.succeeded",
				providerId: this.id,
				providerEventId,
				eventIdSource,
				checkoutReference: payload.reference || "",
				paymentReference: pesalinkRef,
				providerReference: pesalinkRef,
				orderDraftId: payload.reference || "",
				amount: amountMinor,
				currency: "KES",
				customer: {
					email: "",
					phone: payload.sourceAccountMasked,
				},
				channel: "bank_transfer",
				raw: payload,
			};
		}

		if (payload.status === "FAILED") {
			return {
				type: "charge.failed",
				providerId: this.id,
				providerEventId,
				eventIdSource,
				checkoutReference: payload.reference || "",
				paymentReference: pesalinkRef,
				providerReference: pesalinkRef,
				orderDraftId: payload.reference || "",
				reason: payload.narrative || "PesaLink transaction failed",
				raw: payload,
			};
		}

		return {
			type: "unhandled",
			providerEventType: payload.status || "unhandled",
			providerEventId,
			eventIdSource,
			raw: payload,
		};
	}

	async getPaymentStatus(
		ctx: PaymentProviderRuntimeContext,
		paymentOrCheckoutReference: string,
		credentials: PaymentProviderCredentials,
	): Promise<{
		status: "pending" | "succeeded" | "failed";
		paymentReference?: string;
		amount?: number;
		currency?: string;
		reason?: string;
	}> {
		if (!paymentOrCheckoutReference) {
			return {
				status: "failed",
				reason: "Missing reference for PesaLink status query",
			};
		}

		const creds = this.resolveCredentials(credentials);
		const fetchFn = ctx.http.fetch;

		try {
			const res = await fetchFn(
				`${creds.baseUrl}/api/v1/settlements/query?reference=${encodeURIComponent(paymentOrCheckoutReference)}`,
				{
					headers: {
						Authorization: `Bearer ${creds.apiKey}`,
						Accept: "application/json",
					},
				},
			);

			if (!res.ok) {
				return {
					status: "pending",
					reason: `PesaLink gateway returned ${res.status}`,
				};
			}

			const data = (await res.json()) as PesalinkStatusResponse;
			let status: "pending" | "succeeded" | "failed" = "pending";
			if (data.status === "SUCCESS") status = "succeeded";
			else if (data.status === "FAILED") status = "failed";

			return {
				status,
				paymentReference: data.pesalinkReference || paymentOrCheckoutReference,
				amount: Math.round(data.amount * 100),
				currency: "KES",
				reason: data.message,
			};
		} catch (err: unknown) {
			return {
				status: "pending",
				reason: String(err),
			};
		}
	}

	async refund(
		_ctx: PaymentProviderRuntimeContext,
		input: CreateRefundInput,
		_credentials: PaymentProviderCredentials,
	): Promise<RefundResult> {
		if (!input.refundRequestId || !input.refundRequestId.trim()) {
			throw new Error("PesaLink refund requires a non-empty refundRequestId for operation idempotency");
		}

		return {
			providerRefundId: `pesalink:rev:${input.refundRequestId}`,
			refundRequestId: input.refundRequestId,
			status: "pending",
			amount: input.amount ?? 0,
			currency: input.currency.toUpperCase(),
		};
	}
}
