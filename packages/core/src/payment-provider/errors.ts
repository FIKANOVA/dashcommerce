/**
 * Thrown by a provider's `initCheckout` when the provider refuses the cart's
 * currency, for example a Paystack account that isn't enabled for USD.
 * Core answers `create-session` with a 400 the customer can act on, instead
 * of a 500 that suggests trying again.
 *
 * Core recognises it by `code`, not `instanceof`, so a provider package
 * bundled with its own copy of core still works.
 */
export class CurrencyNotSupportedError extends Error {
	readonly code = "currency_not_supported";

	constructor(readonly currency: string) {
		super(`The payment provider does not accept ${currency} for this shop`);
		this.name = "CurrencyNotSupportedError";
	}
}

/** True for a {@link CurrencyNotSupportedError}, from any copy of core. */
export function isCurrencyNotSupportedError(err: unknown): err is CurrencyNotSupportedError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "currency_not_supported" &&
		typeof (err as { currency?: unknown }).currency === "string"
	);
}

/**
 * Thrown when the payment provider (or core, for a provider without the
 * feature) refuses a subscription action such as cancel or resume, for
 * example because the subscription is already inactive there. The admin
 * route answers with a 409 and this message, not a 500.
 *
 * Recognised by `code`, as {@link CurrencyNotSupportedError} is.
 */
export class SubscriptionActionRefusedError extends Error {
	readonly code = "subscription_action_refused";

	constructor(message: string) {
		super(message);
		this.name = "SubscriptionActionRefusedError";
	}
}

/** True for a {@link SubscriptionActionRefusedError}, from any copy of core. */
export function isSubscriptionActionRefusedError(
	err: unknown,
): err is SubscriptionActionRefusedError {
	return (
		typeof err === "object" &&
		err !== null &&
		(err as { code?: unknown }).code === "subscription_action_refused"
	);
}
