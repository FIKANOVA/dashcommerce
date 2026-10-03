/**
 * PaystackPaymentProvider — Paystack implementing @dashcommerce/core's
 * PaymentProvider interface.
 *
 * Channel note: Paystack's hosted checkout page offers whichever
 * channels are enabled on the merchant's Paystack Kenya account
 * ("card", "mobile_money" — M-Pesa STK is triggered from inside the
 * `mobile_money` channel on the hosted page).
 */

import type {
	CreateRefundInput,
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
import { call, type PaystackClientOptions } from "./client";
import { verifyPaystackSignature } from "./webhook-verify";

const SUPPORTED_CURRENCIES = new Set(["KES", "NGN", "GHS", "ZAR", "USD"]);

const PAYSTACK_CHANNEL_MAP: Record<string, string> = {
	card: "card",
	mpesa: "mobile_money",
	"m-pesa": "mobile_money",
	mobile_money: "mobile_money",
};

function toPaystackClient(credentials: PaymentProviderCredentials): PaystackClientOptions {
	return { secretKey: credentials.secretKey };
}

function mapChannels(preferred: string[] | undefined): string[] | undefined {
	if (!preferred || preferred.length === 0) return undefined;
	const mapped = new Set<string>();
	for (const p of preferred) {
		const m = PAYSTACK_CHANNEL_MAP[p.toLowerCase()];
		if (m) mapped.add(m);
	}
	return mapped.size > 0 ? Array.from(mapped) : undefined;
}

interface PaystackInitializeData {
	authorization_url: string;
	access_code: string;
	reference: string;
}

interface PaystackWebhookEvent {
	event: string;
	data: {
		id: number;
		reference: string;
		amount: number;
		currency: string;
		status?: string;
		customer?: {
			id?: number;
			email?: string;
			first_name?: string;
			last_name?: string;
			phone?: string;
		};
		authorization?: { channel?: string };
		channel?: string;
		metadata?: {
			orderDraftId?: string;
			checkoutReference?: string;
			billingAddress?: unknown;
			shippingAddress?: unknown;
			[key: string]: unknown;
		};
		gateway_response?: string;
	};
}

interface PaystackVerifyData {
	id: number;
	reference: string;
	amount: number;
	currency: string;
	status: string;
	gateway_response?: string;
	channel?: string;
}

interface PaystackRefundData {
	id: number;
	status: string;
	amount: number;
	currency: string;
}

export const paystackPaymentProvider: PaymentProvider = {
	id: "paystack",
	label: "Paystack",

	supportsCurrency(currency: string): boolean {
		if (!currency || typeof currency !== "string") return false;
		return SUPPORTED_CURRENCIES.has(currency.trim().toUpperCase());
	},

	async initCheckout(
		ctx: PaymentProviderRuntimeContext,
		input: InitCheckoutInput,
		credentials: PaymentProviderCredentials,
	): Promise<InitCheckoutResult> {
		const client = toPaystackClient(credentials);
		const channels = mapChannels(input.preferredChannels);
		const checkoutRef = `dc_${input.orderDraftId}`;

		const data = await call<PaystackInitializeData>(ctx, {
			client,
			path: "/transaction/initialize",
			body: {
				email: input.customer.email,
				amount: input.amount,
				currency: input.currency.toUpperCase(),
				reference: checkoutRef,
				callback_url: input.successUrl,
				metadata: {
					orderDraftId: input.orderDraftId,
					checkoutReference: checkoutRef,
					...input.metadata,
				},
				...(channels ? { channels } : {}),
			},
		});

		return {
			kind: "redirect",
			redirectUrl: data.authorization_url,
			checkoutReference: data.reference,
			providerReference: data.reference,
		};
	},

	async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
		const result = await verifyPaystackSignature({
			payload: input.rawBody,
			signatureHeader: input.signatureHeader,
			secret: input.secret,
		});
		return { ok: result.ok, reason: result.reason };
	},

	parseWebhookEvent(rawBody: string): NormalizedPaymentEvent {
		let event: PaystackWebhookEvent;
		try {
			event = JSON.parse(rawBody);
		} catch {
			return {
				type: "unhandled",
				providerEventType: "unparseable",
				raw: rawBody,
			};
		}

		if (!event || typeof event !== "object" || !event.event) {
			return {
				type: "unhandled",
				providerEventType: "malformed",
				raw: event,
			};
		}

		if (event.event === "charge.success") {
			const d = event.data;
			const orderDraftId = d?.metadata?.orderDraftId;
			if (!orderDraftId) {
				return {
					type: "unhandled",
					providerEventType: event.event,
					raw: event,
				};
			}

			const customerName = [d.customer?.first_name, d.customer?.last_name]
				.filter(Boolean)
				.join(" ");

			const rawChannel = d.channel ?? d.authorization?.channel;
			const displayChannel =
				rawChannel === "mobile_money"
					? "M-Pesa"
					: rawChannel === "card"
						? "Card"
						: rawChannel;

			return {
				type: "charge.succeeded",
				orderDraftId,
				providerId: "paystack",
				checkoutReference: d.metadata?.checkoutReference ?? d.reference,
				paymentReference: String(d.id),
				providerReference: d.reference,
				providerEventId: String(d.id ?? d.reference),
				eventIdSource: "native",
				amount: d.amount,
				currency: (d.currency ?? "KES").toUpperCase(),
				customer: {
					email: d.customer?.email ?? "",
					...(customerName ? { name: customerName } : {}),
					...(d.customer?.phone ? { phone: d.customer.phone } : {}),
				},
				...(displayChannel ? { channel: displayChannel } : {}),
				raw: event,
			};
		}

		if (event.event === "charge.failed") {
			const d = event.data;
			const orderDraftId = d?.metadata?.orderDraftId;
			if (!orderDraftId) {
				return {
					type: "unhandled",
					providerEventType: event.event,
					raw: event,
				};
			}

			return {
				type: "charge.failed",
				orderDraftId,
				providerId: "paystack",
				checkoutReference: d.metadata?.checkoutReference ?? d.reference,
				paymentReference: String(d.id),
				providerReference: d.reference,
				providerEventId: String(d.id ?? d.reference),
				eventIdSource: "native",
				reason: d.gateway_response,
				raw: event,
			};
		}

		return {
			type: "unhandled",
			providerEventType: event.event,
			raw: event,
		};
	},

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
		const client = toPaystackClient(credentials);
		if (!paymentOrCheckoutReference) {
			return {
				status: "failed",
				reason: "No reference provided for payment status lookup",
			};
		}

		const data = await call<PaystackVerifyData>(ctx, {
			client,
			method: "GET",
			path: `/transaction/verify/${encodeURIComponent(paymentOrCheckoutReference)}`,
		});

		let status: "pending" | "succeeded" | "failed";
		if (data.status === "success") {
			status = "succeeded";
		} else if (data.status === "failed") {
			status = "failed";
		} else {
			status = "pending";
		}

		return {
			status,
			paymentReference: String(data.id),
			amount: data.amount,
			currency: data.currency?.toUpperCase(),
			reason: data.gateway_response,
		};
	},

	async refund(
		ctx: PaymentProviderRuntimeContext,
		input: CreateRefundInput,
		credentials: PaymentProviderCredentials,
	): Promise<RefundResult> {
		if (!input.refundRequestId || !input.refundRequestId.trim()) {
			throw new Error("Paystack refund requires a non-empty refundRequestId for operation idempotency");
		}

		const client = toPaystackClient(credentials);
		const transactionRef = input.paymentReference ?? input.providerReference;
		if (!transactionRef) {
			throw new Error("Paystack refund requires paymentReference or providerReference");
		}

		const note = input.reason
			? `${input.refundRequestId}: ${input.reason}`
			: input.refundRequestId;

		const data = await call<PaystackRefundData>(ctx, {
			client,
			path: "/refund",
			body: {
				transaction: transactionRef,
				...(input.amount !== undefined ? { amount: input.amount } : {}),
				currency: input.currency.toUpperCase(),
				merchant_note: note,
			},
		});

		const status: RefundResult["status"] =
			data.status === "processed" || data.status === "success"
				? "succeeded"
				: data.status === "failed"
					? "failed"
					: "pending";

		return {
			providerRefundId: String(data.id),
			status,
			amount: data.amount,
			currency: (data.currency ?? input.currency).toUpperCase(),
		};
	},

	formatAmount(money: Money): string {
		const major = (money.amount / 100).toFixed(2);
		return `${money.currency.toUpperCase()} ${major}`;
	},
};
