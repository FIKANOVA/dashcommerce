/**
 * MockPaymentProvider — an in-memory PaymentProvider for tests and for
 * running checkout flows with no external gateway credentials.
 *
 * Deterministic: `initCheckout` succeeds by default and returns a predictable
 * reference; webhook verification passes iff `secret === "test-secret"`;
 * refunds succeed by default and enforce idempotency through refundRequestId.
 */

import type {
	CreateRefundInput,
	EventIdSource,
	InitCheckoutInput,
	InitCheckoutResult,
	Money,
	NormalizedPaymentEvent,
	PaymentProvider,
	RefundResult,
	VerifyWebhookInput,
	VerifyWebhookResult,
} from "./types";

export interface MockPaymentProviderOptions {
	/** Custom provider id (defaults to "mock"). */
	id?: string;
	/** Custom supported currencies (defaults to ["KES", "USD"]). */
	supportedCurrencies?: string[];
	/** Force initCheckout/refund to fail, for negative-path tests. */
	failInit?: boolean;
	failRefund?: boolean;
	/** Force webhook verification to fail. */
	failVerifyWebhook?: boolean;
	/** Force async pending checkout mode instead of hosted redirect. */
	asyncPendingCheckout?: boolean;
}

export function createMockPaymentProvider(
	options: MockPaymentProviderOptions = {},
): PaymentProvider {
	const providerId = options.id ?? "mock";
	return {
		id: providerId,
		label: `Mock (${providerId})`,

		supportsCurrency(currency: string): boolean {
			if (!currency || typeof currency !== "string") return false;
			const normalized = currency.trim().toUpperCase();
			const supported = options.supportedCurrencies
				? options.supportedCurrencies.map((c) => c.trim().toUpperCase())
				: ["KES", "USD"];
			return supported.includes(normalized);
		},

		async initCheckout(_ctx, input: InitCheckoutInput): Promise<InitCheckoutResult> {
			if (options.failInit) {
				throw new Error("MockPaymentProvider: forced initCheckout failure");
			}

			const checkoutReference = `mock_ref_${input.orderDraftId}`;

			if (options.asyncPendingCheckout) {
				return {
					kind: "pending",
					checkoutReference,
					status: "pending",
					providerReference: checkoutReference,
				};
			}

			const url = new URL(input.successUrl);
			url.searchParams.set("mock", "1");

			return {
				kind: "redirect",
				checkoutReference,
				redirectUrl: url.toString(),
				status: "pending",
				providerReference: checkoutReference,
			};
		},

		async verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult> {
			if (
				options.failVerifyWebhook ||
				input.signatureHeader === "wrong-secret" ||
				input.signatureHeader === "invalid"
			) {
				return { ok: false, reason: "mock: signature verification failed" };
			}
			if (input.secret !== "test-secret") {
				return { ok: false, reason: "mock: secret mismatch" };
			}
			return { ok: true };
		},

		parseWebhookEvent(rawBody: string): NormalizedPaymentEvent {
			let event: {
				id?: string;
				type?: string;
				orderDraftId?: string;
				providerReference?: string;
				paymentReference?: string;
				checkoutReference?: string;
				amount?: number;
				currency?: string;
				email?: string;
				shippingAddress?: any;
				billingAddress?: any;
			};
			try {
				event = JSON.parse(rawBody);
			} catch {
				return {
					type: "unhandled",
					providerEventType: "unparseable",
					raw: rawBody,
				};
			}

			if (!event || typeof event !== "object" || !event.type) {
				return {
					type: "unhandled",
					providerEventType: "unknown",
					raw: event,
				};
			}

			const eventIdSource: EventIdSource = event.id ? "native" : "derived";
			const providerEventId =
				event.id ?? `mock:${event.type}:${event.orderDraftId ?? event.paymentReference ?? "evt"}`;
			const paymentRef = event.paymentReference ?? event.providerReference ?? "mock_pay_ref";
			const checkoutRef = event.checkoutReference ?? `mock_cs_${event.orderDraftId ?? "draft"}`;

			if (event.type === "charge.succeeded") {
				return {
					type: "charge.succeeded",
					orderDraftId: event.orderDraftId ?? "",
					providerId,
					providerEventId,
					eventIdSource,
					checkoutReference: checkoutRef,
					paymentReference: paymentRef,
					amount: event.amount ?? 0,
					currency: event.currency ?? "KES",
					customer: { email: event.email ?? "test@example.com" },
					shippingAddress: event.shippingAddress,
					billingAddress: event.billingAddress ?? event.shippingAddress,
					channel: "Mock",
					raw: event,
					providerReference: paymentRef,
				};
			}

			if (event.type === "charge.failed") {
				return {
					type: "charge.failed",
					orderDraftId: event.orderDraftId ?? "",
					providerId,
					providerEventId,
					eventIdSource,
					checkoutReference: checkoutRef,
					paymentReference: paymentRef,
					reason: "Mock payment failure",
					raw: event,
					providerReference: paymentRef,
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

		async refund(_ctx, input: CreateRefundInput): Promise<RefundResult> {
			if (options.failRefund) {
				throw new Error("MockPaymentProvider: forced refund failure");
			}
			const paymentRef = input.paymentReference ?? input.providerReference ?? "mock_pay_ref";
			return {
				providerRefundId: `mock_refund_${input.refundRequestId}_${paymentRef}`,
				refundRequestId: input.refundRequestId,
				status: "succeeded",
				amount: input.amount ?? 0,
				currency: input.currency,
			};
		},

		formatAmount(money: Money): string {
			return `${money.currency.toUpperCase()} ${(money.amount / 100).toFixed(2)}`;
		},
	};
}
