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
import { PalplussClient } from "./client";
import { normalizeKenyanPhone } from "./phone";
import type { PalplussCredentials } from "./types";

function toPalplussCredentials(
	creds: PaymentProviderCredentials,
): PalplussCredentials {
	const c = creds as unknown as Record<string, unknown>;
	return {
		apiKey: String(c.apiKey ?? c.secretKey ?? ""),
		secretKey: c.secretKey ? String(c.secretKey) : undefined,
		channelId: String(c.channelId ?? ""),
		authScheme: c.authScheme as PalplussCredentials["authScheme"],
		baseUrl: c.baseUrl ? String(c.baseUrl) : undefined,
		callbackUrl: c.callbackUrl ? String(c.callbackUrl) : undefined,
		webhookSecret: c.webhookSecret ? String(c.webhookSecret) : undefined,
	};
}

export class PalplussPaymentProvider implements PaymentProvider {
	readonly id = "palpluss";
	readonly label = "PalPluss (M-Pesa STK)";

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

	async initCheckout(
		ctx: PaymentProviderRuntimeContext,
		input: InitCheckoutInput,
		credentials: PaymentProviderCredentials,
	): Promise<InitCheckoutResult> {
		const normCurrency = input.currency.trim().toUpperCase();
		if (!this.supportsCurrency(normCurrency)) {
			throw new Error(
				`PalPluss STK only supports KES currency. Received: ${input.currency}`,
			);
		}

		const phone = normalizeKenyanPhone(
			input.customer.phone || (input.metadata as any)?.phone,
		);

		if (
			typeof input.amount !== "number" ||
			!Number.isInteger(input.amount) ||
			input.amount <= 0
		) {
			throw new Error(
				`PalPluss STK requires a positive integer minor unit amount. Received: ${input.amount}`,
			);
		}

		const amountKes = input.amount / 100;

		const creds = toPalplussCredentials(credentials);
		if (!creds.channelId) {
			throw new Error("PalPluss requires an explicit configured channelId");
		}

		const callbackUrl =
			creds.callbackUrl || (credentials as any)?.callbackUrl;
		if (!callbackUrl || !callbackUrl.startsWith("https://")) {
			throw new Error(
				"PalPluss STK requires an allowlisted HTTPS callbackUrl",
			);
		}

		// Documented length constraints: accountReference <= 12, description <= 13
		const sanitizedDraftId = input.orderDraftId
			.replace(/[^a-zA-Z0-9]/g, "")
			.slice(-12);
		const accountReference = sanitizedDraftId.toUpperCase() || "ORDER";
		const description = `Order ${accountReference.slice(-7)}`.slice(0, 13);

		const client = new PalplussClient(creds, ctx.http);
		const res = await client.initiateStk({
			phoneNumber: phone,
			amount: amountKes,
			accountReference,
			description,
			channelId: creds.channelId,
			callbackUrl,
		});

		return {
			kind: "pending",
			status: "pending",
			checkoutReference: res.transactionId,
			providerReference: res.transactionId,
		};
	}

	async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
		// If a webhook secret is provided and the signature header matches HMAC
		if (input.secret && input.signatureHeader) {
			try {
				const encoder = new TextEncoder();
				const key = await crypto.subtle.importKey(
					"raw",
					encoder.encode(input.secret),
					{ name: "HMAC", hash: "SHA-256" },
					false,
					["verify"],
				);
				const sigBytes = new Uint8Array(
					(input.signatureHeader.match(/.{1,2}/g) || []).map((byte) =>
						Number.parseInt(byte, 16),
					),
				);
				const valid = await crypto.subtle.verify(
					"HMAC",
					key,
					sigBytes,
					encoder.encode(input.rawBody),
				);
				if (valid) {
					return { ok: true };
				}
			} catch {
				// signature check failed
			}
			return {
				ok: false,
				reason: "invalid_hmac_signature",
			};
		}

		// As specified in the core plan: PalPluss public webhook guide does not document
		// a mandatory signature scheme. Webhooks without cryptographic signature are untrusted hints
		// that require an authenticated server-to-server transaction status lookup before fulfillment.
		return {
			ok: false,
			reason:
				"unsigned_reconciliation_hint_requires_server_lookup: unauthenticated callback must be verified via getPaymentStatus",
		};
	}

	parseWebhookEvent(rawBody: string): NormalizedPaymentEvent {
		let body: any;
		try {
			body = JSON.parse(rawBody);
		} catch {
			return {
				type: "unhandled",
				providerEventType: "unparseable",
				raw: rawBody,
			};
		}

		if (!body || typeof body !== "object") {
			return {
				type: "unhandled",
				providerEventType: "invalid_payload",
				raw: rawBody,
			};
		}

		const channelId = String(body.channelId || "default");
		const transactionId = String(
			body.transactionId || body.reference || body.checkoutRequestID || "",
		);
		const statusRaw = String(body.status || "").toUpperCase();

		// Derive deterministic event identity when native event ID is absent:
		// palpluss:<channelId>:<transactionId>:<status>
		const nativeId = body.id || body.eventId;
		const eventIdSource: EventIdSource = nativeId ? "native" : "derived";
		const providerEventId = String(
			nativeId || `palpluss:${channelId}:${transactionId}:${statusRaw}`,
		);

		const orderDraftId = String(
			body.orderDraftId || body.accountReference || "",
		);

		if (statusRaw === "SUCCESS" || statusRaw === "PAID") {
			const amountKes = Number(body.amount || 0);
			const amountMinor = Math.round(amountKes * 100);
			const paymentReference = String(
				body.mpesaReceipt || body.receiptNumber || transactionId,
			);

			return {
				type: "charge.succeeded",
				providerId: this.id,
				providerEventId,
				eventIdSource,
				paymentReference,
				checkoutReference: transactionId || undefined,
				orderDraftId,
				amount: amountMinor,
				currency: "KES",
				customer: {
					email: body.email || "",
					phone: body.phoneNumber || undefined,
					name: body.customerName || undefined,
				},
				raw: body,
			};
		}

		if (
			statusRaw === "FAILED" ||
			statusRaw === "CANCELLED" ||
			statusRaw === "EXPIRED"
		) {
			return {
				type: "charge.failed",
				providerId: this.id,
				providerEventId,
				eventIdSource,
				paymentReference: transactionId,
				checkoutReference: transactionId,
				orderDraftId,
				reason: body.failureReason || body.message || statusRaw.toLowerCase(),
				raw: body,
			};
		}

		return {
			type: "unhandled",
			providerEventId,
			eventIdSource,
			providerEventType: statusRaw || "unknown",
			raw: body,
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
		const creds = toPalplussCredentials(credentials);
		const client = new PalplussClient(creds, ctx.http);

		try {
			const res = await client.getTransactionStatus(paymentOrCheckoutReference);
			if (res.status === "SUCCESS") {
				return {
					status: "succeeded",
					paymentReference: res.mpesaReceipt || res.transactionId,
					amount: Math.round(res.amount * 100),
					currency: "KES",
				};
			}

			if (
				res.status === "FAILED" ||
				res.status === "CANCELLED" ||
				res.status === "EXPIRED"
			) {
				return {
					status: "failed",
					reason: res.failureReason || res.status.toLowerCase(),
				};
			}

			return {
				status: "pending",
			};
		} catch (err: any) {
			return {
				status: "pending",
				reason: `Status check indeterminate: ${err.message}`,
			};
		}
	}

	async refund(
		_ctx: PaymentProviderRuntimeContext,
		input: CreateRefundInput,
		_credentials: PaymentProviderCredentials,
	): Promise<RefundResult> {
		if (!input.refundRequestId) {
			throw new Error("refundRequestId is required for refund idempotency");
		}
		// PalPluss STK does not support automated API refunds.
		// As specified in the core plan, automated refunds must not be implemented as B2C.
		return {
			status: "failed",
			providerRefundId: "manual_reversal_required",
			amount: input.amount ?? 0,
			currency: input.currency ?? "KES",
		};
	}
}

export const palplussPaymentProvider = new PalplussPaymentProvider();
