/**
 * Public entry point for this fork's PaymentProvider abstraction —
 * `@dashcommerce/core/payment-provider` export. Sibling gateway
 * packages (e.g. Paystack, POS, offline processors) import types from
 * here and call `registerPaymentProvider` at module load time.
 */
export type {
	CreateRefundInput,
	EventIdSource,
	InitCheckoutInput,
	InitCheckoutResult,
	Money,
	NormalizedPaymentEvent,
	PaymentProvider,
	PaymentProviderAddress,
	PaymentProviderCredentials,
	PaymentProviderCustomer,
	PaymentProviderLineItem,
	PaymentProviderRuntimeContext,
	PaymentProviderShippingOption,
	RefundResult,
	StripeCheckoutOptions,
	VerifyWebhookInput,
	VerifyWebhookResult,
} from "./payment-provider/types";
export { stripePaymentProvider } from "./payment-provider/stripe-provider";
export {
	createMockPaymentProvider,
	type MockPaymentProviderOptions,
} from "./payment-provider/mock-provider";
export {
	getPaymentProvider,
	listPaymentProviders,
	registerPaymentProvider,
	resetPaymentProviders,
	resolveProvider,
	type PaymentProviderId,
	type RegisterProviderOptions,
} from "./payment-provider/registry";
export { toPaymentProviderRuntimeContext } from "./payment-provider/runtime";
