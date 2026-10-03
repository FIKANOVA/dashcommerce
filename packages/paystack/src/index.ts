/**
 * @dashcommerce/paystack
 *
 * Paystack payment provider package for DashCommerce.
 *
 * Implements hosted checkout (card + M-Pesa STK), Web Crypto HMAC-SHA512
 * webhook verification, transaction status reconciliation, idempotency-tracked refunds,
 * and Kenyan county shipping presets.
 */

import { registerPaymentProvider } from "@dashcommerce/core/payment-provider";
import { paystackPaymentProvider } from "./provider";

export { paystackPaymentProvider } from "./provider";
export {
	verifyPaystackSignature,
	type VerifyInput,
	type VerifyResult,
} from "./webhook-verify";
export {
	call as callPaystack,
	PaystackApiError,
	PAYSTACK_API_BASE,
	type PaystackClientOptions,
	type PaystackCallOptions,
	type PaystackResponse,
} from "./client";
export {
	KENYA_COUNTY_CODES,
	type KenyaCounty,
	NAIROBI_METRO_COUNTIES,
	REST_OF_KENYA_COUNTIES,
	createKenyaShippingPresets,
	type KenyaShippingPresetOptions,
} from "./kenya-shipping";

/**
 * Registers the Paystack provider with DashCommerce's runtime registry.
 */
export function registerPaystackProvider(opts?: { override?: boolean }): void {
	registerPaymentProvider(paystackPaymentProvider, opts);
}

// Auto-register unless explicitly disabled (can be overridden with { override: true })
try {
	registerPaymentProvider(paystackPaymentProvider);
} catch {
	// Already registered or duplicate in test runner, ignore initial collision
}
