/**
 * StripePaymentProvider — Stripe adapter implementing PaymentProvider.
 *
 * Wraps existing ../stripe/* modules without modifying their internals,
 * preserving full compatibility with existing Stripe checkout, webhooks,
 * taxes, subscriptions, Connect transfers, and refunds.
 */

import type { PluginContext } from "emdash";
import type {
	CreateRefundInput,
	InitCheckoutInput,
	InitCheckoutResult,
	NormalizedPaymentEvent,
	PaymentProvider,
	PaymentProviderAddress,
	PaymentProviderCredentials,
	PaymentProviderRuntimeContext,
	RefundResult,
	VerifyWebhookInput,
	VerifyWebhookResult,
} from "./types";
import {
	createCheckoutSession,
	type CheckoutLineItem,
	type StripeCheckoutSession,
} from "../stripe/checkout-sessions";
import { verifyStripeSignature } from "../stripe/webhook-verify";
import { createRefund as stripeCreateRefund } from "../stripe/refunds";
import type { StripeClientOptions } from "../stripe/client";
import type { StripePaymentIntent } from "../stripe/payment-intents";

function toStripeClient(credentials: PaymentProviderCredentials): StripeClientOptions {
	return { secretKey: credentials.secretKey };
}

/** Cast our narrow PaymentProviderRuntimeContext to PluginContext for existing helpers. */
function asPluginContext(ctx: PaymentProviderRuntimeContext): PluginContext {
	return ctx as unknown as PluginContext;
}

export const stripePaymentProvider: PaymentProvider = {
	id: "stripe",
	label: "Stripe",

	supportsCurrency(currency: string): boolean {
		if (!currency || typeof currency !== "string") return false;
		const normalized = currency.trim().toUpperCase();
		return normalized.length === 3;
	},

	async initCheckout(
		ctx: PaymentProviderRuntimeContext,
		input: InitCheckoutInput,
		credentials: PaymentProviderCredentials,
	): Promise<InitCheckoutResult> {
		const client = toStripeClient(credentials);
		const stripeOpts = input.providerOptions?.stripe;
		const isSubscription = stripeOpts?.mode === "subscription";

		const lineItems: CheckoutLineItem[] = input.lineItems.map((li) => ({
			amount: li.amount,
			currency: li.currency.toLowerCase(),
			name: li.name,
			description: li.description,
			quantity: li.quantity,
			metadata: li.metadata,
			...(li.recurring
				? {
						recurring: {
							interval: li.recurring.interval,
							intervalCount: li.recurring.intervalCount ?? 1,
						},
					}
				: {}),
			...(li.taxBehavior === "inclusive" || li.taxBehavior === "exclusive"
				? { taxBehavior: li.taxBehavior }
				: {}),
		}));

		const session: StripeCheckoutSession = await createCheckoutSession(
			asPluginContext(ctx),
			{
				mode: isSubscription ? "subscription" : "payment",
				successUrl: input.successUrl,
				cancelUrl: input.cancelUrl,
				lineItems,
				customerEmail: input.customer.email,
				clientReferenceId: input.orderDraftId,
				metadata: { orderDraftId: input.orderDraftId, ...input.metadata },
				billingAddressCollection: stripeOpts?.billingAddressCollection ?? "auto",
				...(input.shippingOptions && input.shippingOptions.length > 0
					? {
							shippingOptions: input.shippingOptions.map((s) => ({
								displayName: s.label,
								amount: s.amount,
								currency: s.currency.toLowerCase(),
								metadata: s.metadata,
							})),
						}
					: {}),
				...(input.allowedShippingCountries && input.allowedShippingCountries.length > 0
					? {
							shippingAddressCollection: {
								allowedCountries: input.allowedShippingCountries,
							},
						}
					: {}),
				...(stripeOpts?.automaticTax ? { automaticTax: true } : {}),
				...(stripeOpts?.subscriptionTrialPeriodDays &&
				stripeOpts.subscriptionTrialPeriodDays > 0
					? { subscriptionTrialPeriodDays: stripeOpts.subscriptionTrialPeriodDays }
					: {}),
				...(stripeOpts?.subscriptionMetadata
					? { subscriptionMetadata: stripeOpts.subscriptionMetadata }
					: {}),
				...(!isSubscription
					? {
							paymentIntentMetadata: {
								orderDraftId: input.orderDraftId,
								...input.metadata,
							},
							paymentIntentReceiptEmail: input.customer.email,
							...(stripeOpts?.transferData
								? { paymentIntentTransferData: stripeOpts.transferData }
								: {}),
							...(stripeOpts?.applicationFeeAmount !== undefined
								? {
										paymentIntentApplicationFeeAmount:
											stripeOpts.applicationFeeAmount,
									}
								: {}),
						}
					: {}),
			},
			client,
			`cs:${input.orderDraftId}`,
		);

		if (!session.url) {
			throw new Error("Stripe did not return a hosted checkout URL");
		}

		return {
			kind: "redirect",
			checkoutReference: session.id,
			redirectUrl: session.url,
			status: "pending",
			providerReference: session.id,
		};
	},

	async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
		const result = await verifyStripeSignature({
			payload: input.rawBody,
			signatureHeader: input.signatureHeader,
			secret: input.secret,
		});
		return { ok: result.ok, reason: result.reason };
	},

	parseWebhookEvent(rawBody: string): NormalizedPaymentEvent {
		let event: { id?: string; type?: string; data?: { object: unknown } };
		try {
			event = JSON.parse(rawBody);
		} catch {
			return { type: "unhandled", providerEventType: "unparseable", raw: rawBody };
		}

		if (!event || typeof event !== "object" || !event.type) {
			return { type: "unhandled", providerEventType: "unknown", raw: event };
		}

		const providerEventId = event.id ?? `stripe:${event.type}:${Date.now()}`;
		const eventIdSource = event.id ? "native" : "derived";

		if (event.type === "checkout.session.completed") {
			const session = event.data?.object as StripeCheckoutSession;
			const orderDraftId = session.metadata?.orderDraftId ?? session.client_reference_id;
			if (!orderDraftId) {
				return {
					type: "unhandled",
					providerEventType: event.type,
					providerEventId,
					eventIdSource,
					raw: event,
				};
			}

			const custAddr = session.customer_details?.address;
			const shipAddr = session.shipping_details?.address;

			const billingAddress: PaymentProviderAddress | undefined = custAddr
				? {
						line1: custAddr.line1 ?? undefined,
						line2: custAddr.line2 ?? undefined,
						city: custAddr.city ?? undefined,
						state: custAddr.state ?? undefined,
						postalCode: custAddr.postal_code ?? undefined,
						country: custAddr.country ?? undefined,
					}
				: undefined;

			const shippingAddress: PaymentProviderAddress | undefined = shipAddr
				? {
						line1: shipAddr.line1 ?? undefined,
						line2: shipAddr.line2 ?? undefined,
						city: shipAddr.city ?? undefined,
						state: shipAddr.state ?? undefined,
						postalCode: shipAddr.postal_code ?? undefined,
						country: shipAddr.country ?? undefined,
					}
				: undefined;

			// Digital-only carts have billingAddress but no shippingAddress.
			// Fall back between billing and shipping so neither is missing when one exists.
			const resolvedBilling = billingAddress ?? shippingAddress;
			const resolvedShipping = shippingAddress ?? billingAddress;
			const paymentReference = session.payment_intent ?? session.id;

			return {
				type: "charge.succeeded",
				orderDraftId,
				providerId: "stripe",
				providerEventId,
				eventIdSource,
				checkoutReference: session.id,
				paymentReference,
				amount: session.amount_total ?? 0,
				currency: (session.currency ?? "usd").toUpperCase(),
				customer: {
					email: session.customer_details?.email ?? "",
					name: session.customer_details?.name,
					phone: session.customer_details?.phone,
				},
				billingAddress: resolvedBilling,
				shippingAddress: resolvedShipping,
				channel: "Card",
				raw: event,
				providerReference: paymentReference,
			};
		}

		if (
			event.type === "payment_intent.payment_failed" ||
			event.type === "payment_intent.canceled"
		) {
			const pi = event.data?.object as StripePaymentIntent;
			const orderDraftId = pi.metadata?.orderDraftId;
			if (!orderDraftId) {
				return {
					type: "unhandled",
					providerEventType: event.type,
					providerEventId,
					eventIdSource,
					raw: event,
				};
			}
			return {
				type: "charge.failed",
				orderDraftId,
				providerId: "stripe",
				providerEventId,
				eventIdSource,
				checkoutReference: pi.metadata?.sessionId,
				paymentReference: pi.id,
				reason: (pi as { last_payment_error?: { message?: string } })
					.last_payment_error?.message,
				raw: event,
				providerReference: pi.id,
			};
		}

		return {
			type: "unhandled",
			providerEventType: event.type,
			providerEventId,
			eventIdSource,
			raw: event,
		};
	},

	async refund(
		ctx: PaymentProviderRuntimeContext,
		input: CreateRefundInput,
		credentials: PaymentProviderCredentials,
	): Promise<RefundResult> {
		const client = toStripeClient(credentials);
		const targetPaymentIntent = input.paymentReference ?? input.providerReference;
		if (!targetPaymentIntent) {
			throw new Error("Stripe refund requires a paymentReference");
		}
		if (!input.refundRequestId) {
			throw new Error("Stripe refund requires a refundRequestId for idempotency");
		}
		const idempotencyKey = `refund:${targetPaymentIntent}:${input.refundRequestId}`;
		const refund = await stripeCreateRefund(
			asPluginContext(ctx),
			{
				paymentIntent: targetPaymentIntent,
				amount: input.amount,
				reason:
					input.reason === "duplicate" ||
					input.reason === "fraudulent" ||
					input.reason === "requested_by_customer"
						? input.reason
						: undefined,
			},
			client,
			idempotencyKey,
		);
		return {
			providerRefundId: refund.id,
			refundRequestId: input.refundRequestId,
			status:
				refund.status === "succeeded"
					? "succeeded"
					: refund.status === "failed"
						? "failed"
						: "pending",
			amount: refund.amount,
			currency: refund.currency.toUpperCase(),
		};
	},

	formatAmount(money): string {
		const major = (money.amount / 100).toFixed(2);
		return `${money.currency.toUpperCase()} ${major}`;
	},
};
