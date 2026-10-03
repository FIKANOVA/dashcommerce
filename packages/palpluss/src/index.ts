import { registerPaymentProvider } from "@dashcommerce/core/payment-provider";
import { PalplussPaymentProvider, palplussPaymentProvider } from "./provider";

export * from "./types";
export * from "./client";
export * from "./phone";
export * from "./payout";
export * from "./provider";

/**
 * Register the PalPluss payment provider into the DashCommerce core registry.
 */
export function registerPalplussProvider(options?: { override?: boolean }): void {
	registerPaymentProvider(palplussPaymentProvider, options);
}
