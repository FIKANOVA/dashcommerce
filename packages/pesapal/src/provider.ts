/**
 * PesapalPaymentProvider — Pesapal v3.0 implementing @dashcommerce/core's
 * PaymentProvider interface.
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
import {
	getAuthToken,
	getTransactionStatus,
	requestRefund,
	submitOrder,
} from "./client";
import type { PesapalCredentials, PesapalSubmitOrderRequest } from "./types";

const SUPPORTED_CURRENCIES = new Set(["KES", "UGX", "TZS", "RWF", "USD", "GBP", "EUR"]);

export interface PesapalProviderOptions {
	ipnId?: string;
	environment?: "sandbox" | "live";
	baseUrl?: string;
}

export class PesapalPaymentProvider implements PaymentProvider {
	readonly id = "pesapal";
	readonly label = "Pesapal";

	constructor(private readonly defaultOptions: PesapalProviderOptions = {}) {}

	supportsCurrency(currency: string): boolean {
		if (typeof currency !== "string") return false;
		return SUPPORTED_CURRENCIES.has(currency.trim().toUpperCase());
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
	): PesapalCredentials {
		const raw = credentials as Record<string, unknown>;
		return {
			consumerKey: String(raw.apiKey ?? raw.secretKey ?? "").trim(),
			consumerSecret: String(raw.secretKey ?? raw.apiKey ?? "").trim(),
			ipnId: raw.channelId ? String(raw.channelId) : (raw.webhookSecret ? String(raw.webhookSecret) : this.defaultOptions.ipnId),
			environment: this.defaultOptions.environment ?? "sandbox",
			baseUrl: raw.baseUrl ? String(raw.baseUrl) : this.defaultOptions.baseUrl,
		};
	}

	async initCheckout(
		ctx: PaymentProviderRuntimeContext,
		input: InitCheckoutInput,
		credentials: PaymentProviderCredentials,
	): Promise<InitCheckoutResult> {
		const normCurrency = input.currency.trim().toUpperCase();
		if (!this.supportsCurrency(normCurrency)) {
			throw new Error(`Pesapal does not support currency: ${input.currency}`);
		}

		const creds = this.resolveCredentials(credentials);
		if (!creds.consumerKey || !creds.consumerSecret) {
			throw new Error("Pesapal requires consumerKey and consumerSecret in credentials");
		}
		if (!creds.ipnId) {
			throw new Error("Pesapal requires a registered ipnId (channelId or webhookSecret)");
		}

		const fetchFn = ctx.http.fetch;
		const token = await getAuthToken(creds, fetchFn);

		const amountMajor = input.amount / 100;

		const orderReq: PesapalSubmitOrderRequest = {
			id: input.orderDraftId,
			currency: normCurrency,
			amount: amountMajor,
			description: `Order ${input.orderDraftId.slice(-8)}`,
			callback_url: input.successUrl,
			notification_id: creds.ipnId,
			cancellation_url: input.cancelUrl,
			billing_address: input.customer.email
				? {
						email_address: input.customer.email,
						first_name: input.customer.name?.split(" ")[0] || "Customer",
						last_name: input.customer.name?.split(" ").slice(1).join(" ") || "",
						phone_number: input.customer.phone,
					}
				: undefined,
		};

		const res = await submitOrder(creds, token, orderReq, fetchFn);

		return {
			kind: "redirect",
			redirectUrl: res.redirect_url,
			checkoutReference: input.orderDraftId,
			providerReference: res.order_tracking_id,
		};
	}

	async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
		let body: Record<string, unknown> = {};
		if (typeof input.rawBody === "string") {
			try {
				body = JSON.parse(input.rawBody);
			} catch {
				const params = new URLSearchParams(input.rawBody);
				body = Object.fromEntries(params.entries());
			}
		}

		const trackingId =
			body.OrderTrackingId ||
			body.orderTrackingId ||
			body.order_tracking_id;

		if (!trackingId) {
			return { ok: false, reason: "Missing OrderTrackingId in Pesapal IPN" };
		}

		return { ok: true };
	}

	parseWebhookEvent(rawBody: string): NormalizedPaymentEvent {
		let body: Record<string, unknown> = {};
		if (typeof rawBody === "string") {
			try {
				body = JSON.parse(rawBody);
			} catch {
				const params = new URLSearchParams(rawBody);
				body = Object.fromEntries(params.entries());
			}
		}

		const orderTrackingId = String(
			body.OrderTrackingId ||
			body.orderTrackingId ||
			body.order_tracking_id ||
			"",
		);
		const merchantReference = String(
			body.OrderMerchantReference ||
			body.orderMerchantReference ||
			body.merchant_reference ||
			"",
		);

		if (!orderTrackingId) {
			return {
				type: "unhandled",
				providerEventType: "missing_tracking_id",
				raw: body,
			};
		}

		const statusRaw = String(
			body.PaymentStatus ||
			body.status ||
			body.payment_status_description ||
			"",
		).toUpperCase();

		const eventIdSource: EventIdSource = body.ConfirmationCode ? "native" : "derived";
		const providerEventId = String(
			body.ConfirmationCode || `pesapal:${orderTrackingId}:${statusRaw || "IPN"}`,
		);

		const amountKes = Number(body.Amount || body.amount || 0);
		const amountMinor = Math.round(amountKes * 100);

		if (statusRaw === "COMPLETED" || statusRaw === "SUCCESS") {
			return {
				type: "charge.succeeded",
				orderDraftId: merchantReference,
				providerId: this.id,
				checkoutReference: merchantReference,
				paymentReference: orderTrackingId,
				providerReference: orderTrackingId,
				providerEventId,
				eventIdSource,
				amount: amountMinor,
				currency: String(body.Currency || body.currency || "KES").toUpperCase(),
				customer: {
					email: String(body.Email || body.email || ""),
					phone: body.Phone ? String(body.Phone) : undefined,
				},
				channel: body.PaymentMethod ? String(body.PaymentMethod) : undefined,
				raw: body,
			};
		}

		if (statusRaw === "FAILED" || statusRaw === "INVALID") {
			return {
				type: "charge.failed",
				orderDraftId: merchantReference,
				providerId: this.id,
				checkoutReference: merchantReference,
				paymentReference: orderTrackingId,
				providerReference: orderTrackingId,
				providerEventId,
				eventIdSource,
				reason: String(body.Description || body.message || statusRaw),
				raw: body,
			};
		}

		return {
			type: "unhandled",
			providerEventType: statusRaw || "unhandled",
			providerEventId,
			eventIdSource,
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
		const creds = this.resolveCredentials(credentials);
		const fetchFn = ctx.http.fetch;
		const token = await getAuthToken(creds, fetchFn);
		const txStatus = await getTransactionStatus(creds, token, paymentOrCheckoutReference, fetchFn);

		const desc = (txStatus.payment_status_description || "").toLowerCase();
		let status: "pending" | "succeeded" | "failed" = "pending";
		if (desc === "completed" || txStatus.status_code === 1) {
			status = "succeeded";
		} else if (desc === "failed" || txStatus.status_code === 2 || desc === "reversed" || txStatus.status_code === 3) {
			status = "failed";
		}

		return {
			status,
			paymentReference: txStatus.order_tracking_id || paymentOrCheckoutReference,
			amount: Math.round((txStatus.amount || 0) * 100),
			currency: (txStatus.currency || "KES").toUpperCase(),
			reason: txStatus.description || txStatus.message,
		};
	}

	async refund(
		ctx: PaymentProviderRuntimeContext,
		input: CreateRefundInput,
		credentials: PaymentProviderCredentials,
	): Promise<RefundResult> {
		if (!input.refundRequestId || !input.refundRequestId.trim()) {
			throw new Error("Pesapal refund requires a non-empty refundRequestId for operation idempotency");
		}

		const creds = this.resolveCredentials(credentials);
		const fetchFn = ctx.http.fetch;
		const token = await getAuthToken(creds, fetchFn);

		const amountMinor = input.amount ?? 0;
		const amountMajor = amountMinor / 100;
		const confirmationCode = input.paymentReference;

		const res = await requestRefund(
			creds,
			token,
			{
				confirmation_code: confirmationCode,
				amount: amountMajor,
				username: "DashCommerce",
				remarks: input.reason || `Refund request ${input.refundRequestId}`,
			},
			fetchFn,
		);

		return {
			providerRefundId: res.refund_tracking_id || `pesapal:ref:${Date.now()}`,
			refundRequestId: input.refundRequestId,
			status: res.status?.toLowerCase() === "success" ? "succeeded" : "pending",
			amount: amountMinor,
			currency: input.currency.toUpperCase(),
		};
	}
}
