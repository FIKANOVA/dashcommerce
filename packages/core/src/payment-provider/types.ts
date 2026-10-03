/**
 * PaymentProvider — the gateway abstraction for DashCommerce.
 *
 * Upstream `emdashCommerce/dashcommerce` wired Stripe directly throughout
 * checkout and webhook routes. This interface introduces the gateway-agnostic
 * seam so multiple processors (Stripe, Paystack, offline POS, etc.) plug in
 * cleanly without modifying core code.
 *
 * Scope: covers checkout initiation (hosted redirect or asynchronous pending),
 * webhook verification and normalized event parsing, payment status, refunds,
 * and currency capability checks.
 */

/** Integer minor units (cents, kobo) — never a float. */
export interface Money {
	amount: number;
	currency: string; // ISO-4217, e.g. "KES", "USD"
}

export interface PaymentProviderCustomer {
	email: string;
	name?: string;
	phone?: string;
}

export interface PaymentProviderAddress {
	line1?: string;
	line2?: string;
	city?: string;
	state?: string;
	postalCode?: string;
	country?: string; // ISO-3166 alpha-2
}

/** One line item for checkout. */
export interface PaymentProviderLineItem {
	name: string;
	description?: string;
	amount: number; // minor units
	currency: string;
	quantity: number;
	metadata?: Record<string, string>;
	recurring?: {
		interval: "day" | "week" | "month" | "year";
		intervalCount?: number;
	};
	taxBehavior?: "inclusive" | "exclusive" | "unspecified";
}

export interface PaymentProviderShippingOption {
	id: string;
	label: string;
	amount: number;
	currency: string;
	metadata?: Record<string, string>;
}

export interface StripeCheckoutOptions {
	mode?: "payment" | "subscription";
	automaticTax?: boolean;
	billingAddressCollection?: "auto" | "required";
	subscriptionTrialPeriodDays?: number;
	subscriptionMetadata?: Record<string, string>;
	transferData?: { destination: string; amount?: number };
	applicationFeeAmount?: number;
}

export interface InitCheckoutInput {
	/** Our own order-draft id — always echoed back in metadata/reference so
	 * the webhook can correlate the provider's event to our cart snapshot. */
	orderDraftId: string;
	amount: number; // minor units, total charge
	currency: string; // ISO-4217
	customer: PaymentProviderCustomer;
	lineItems: PaymentProviderLineItem[];
	successUrl: string;
	cancelUrl: string;
	billingAddress?: PaymentProviderAddress;
	shippingAddress?: PaymentProviderAddress;
	shippingOptions?: PaymentProviderShippingOption[];
	allowedShippingCountries?: string[];
	metadata?: Record<string, string>;
	/** Channel hint for gateways that support payment-method restriction on
	 * the hosted page (Paystack: card/mobile_money/bank; ignored by Stripe). */
	preferredChannels?: string[];
	/** Typed provider-specific options bag */
	providerOptions?: {
		stripe?: StripeCheckoutOptions;
		[providerId: string]: unknown;
	};
}

export type InitCheckoutResult =
	| {
			kind: "redirect";
			/** Checkout reference (e.g. Stripe checkout session id, Paystack access code/reference) */
			checkoutReference: string;
			/** URL to redirect the customer to for hosted payment. */
			redirectUrl: string;
			status?: "pending" | "succeeded";
			/** @deprecated For backwards compatibility during transition; use checkoutReference */
			providerReference?: string;
	  }
	| {
			kind: "pending";
			/** Checkout reference (e.g. STK initiation transaction reference) */
			checkoutReference: string;
			status: "pending";
			/** @deprecated For backwards compatibility during transition; use checkoutReference */
			providerReference?: string;
	  };

export interface VerifyWebhookInput {
	/** Raw request body — signature verification must run against the
	 * exact bytes received, never a re-serialised parse. */
	rawBody: string;
	/** Provider-specific signature header value(s), passed through
	 * verbatim (e.g. `Stripe-Signature`, `x-paystack-signature`). */
	signatureHeader: string;
	/** Provider secret used for the HMAC (webhook secret, not the API
	 * secret key, when the provider distinguishes the two). */
	secret: string;
}

export interface VerifyWebhookResult {
	ok: boolean;
	reason?: string;
}

export type EventIdSource = "native" | "derived";

/** Normalised webhook event, after provider-specific verification and
 * parsing — this is what `routes/webhook.ts` dispatches on, so it never
 * needs to know which gateway sent it. */
export type NormalizedPaymentEvent =
	| {
			type: "charge.succeeded";
			orderDraftId: string;
			providerId: string;
			providerEventId: string;
			eventIdSource: EventIdSource;
			checkoutReference?: string;
			/** Confirmed captured payment reference (e.g. PaymentIntent ID or Charge ID) */
			paymentReference: string;
			amount: number;
			currency: string;
			customer: PaymentProviderCustomer;
			shippingAddress?: PaymentProviderAddress;
			billingAddress?: PaymentProviderAddress;
			/** Free-text label for how the customer paid — surfaced on the
			 * order (e.g. "M-Pesa", "Card", "Apple Pay"). */
			channel?: string;
			raw: unknown;
			/** @deprecated For backwards compatibility during transition; use paymentReference */
			providerReference?: string;
	  }
	| {
			type: "charge.failed";
			orderDraftId: string;
			providerId: string;
			providerEventId: string;
			eventIdSource: EventIdSource;
			checkoutReference?: string;
			paymentReference?: string;
			reason?: string;
			raw: unknown;
			/** @deprecated For backwards compatibility during transition; use paymentReference */
			providerReference?: string;
	  }
	| {
			type: "unhandled";
			providerEventType: string;
			providerEventId?: string;
			eventIdSource?: EventIdSource;
			raw: unknown;
	  };

export interface CreateRefundInput {
	/** Confirmed payment reference from the original successful charge (e.g. PaymentIntent ID, NOT checkout session ID). */
	paymentReference: string;
	/** Scoped unique refund operation ID — mandatory to enforce refund idempotency. */
	refundRequestId: string;
	/** Minor units. Omit for a full refund. */
	amount?: number;
	currency: string;
	reason?: string;
	/** @deprecated For backwards compatibility during transition; use paymentReference */
	providerReference?: string;
}

export interface RefundResult {
	providerRefundId: string;
	refundRequestId?: string;
	status: "pending" | "succeeded" | "failed";
	amount: number;
	currency: string;
}

/** Provider-agnostic client credentials — each implementation defines its
 * own concrete shape but every one is loaded the same way: read from
 * plugin KV under `settings:<provider>SecretKey` / `settings:<provider>WebhookSecret`. */
export interface PaymentProviderCredentials {
	secretKey?: string;
	apiKey?: string;
	webhookSecret?: string;
	[key: string]: unknown;
}

/**
 * The seam. Gateway adapters implement this interface.
 * `ctx` is always the plugin's `PluginContext` (or the subset of it — `http`, `log` —
 * a provider needs); providers must use `ctx.http.fetch` (never global `fetch`) so
 * `allowedHosts` is honoured in the sandbox, and `crypto.subtle` (never a Node `crypto` import)
 * for any HMAC/signature work.
 */
export interface PaymentProvider {
	/** Machine-readable id, e.g. "stripe" | "paystack" | "mock". */
	readonly id: string;

	/** Human label for admin UI / receipts, e.g. "Stripe" | "Paystack". */
	readonly label: string;

	/**
	 * Returns true if this provider supports the given ISO-4217 currency
	 * in this deployment/account.
	 */
	supportsCurrency(currency: string): boolean;

	/** Initialise a hosted or asynchronous checkout. */
	initCheckout(
		ctx: PaymentProviderRuntimeContext,
		input: InitCheckoutInput,
		credentials: PaymentProviderCredentials,
	): Promise<InitCheckoutResult>;

	/** Verify a webhook's signature. Must be constant-time and algorithm-agnostic. */
	verifyWebhook(input: VerifyWebhookInput): Promise<VerifyWebhookResult>;

	/** Parse an already-signature-verified raw webhook body into a normalised event.
	 * Must return an 'unhandled' event rather than throwing on unparseable payloads. */
	parseWebhookEvent(rawBody: string): NormalizedPaymentEvent;

	/** Issue a refund against a previously confirmed captured payment. */
	refund(
		ctx: PaymentProviderRuntimeContext,
		input: CreateRefundInput,
		credentials: PaymentProviderCredentials,
	): Promise<RefundResult>;

	/** Format a minor-units amount for display. */
	formatAmount(money: Money): string;

	/** Verify payment status directly with the provider (for asynchronous polling or reconciliation). */
	getPaymentStatus?(
		ctx: PaymentProviderRuntimeContext,
		paymentOrCheckoutReference: string,
		credentials: PaymentProviderCredentials,
	): Promise<{
		status: "pending" | "succeeded" | "failed";
		paymentReference?: string;
		amount?: number;
		currency?: string;
		reason?: string;
	}>;
}

/** The subset of PluginContext a PaymentProvider implementation may use. */
export interface PaymentProviderRuntimeContext {
	http: { fetch: typeof fetch };
	log: {
		info: (msg: string, meta?: Record<string, unknown>) => void;
		warn: (msg: string, meta?: Record<string, unknown>) => void;
		error: (msg: string, meta?: Record<string, unknown>) => void;
	};
}
