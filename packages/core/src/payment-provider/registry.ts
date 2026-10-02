/**
 * Provider registry + runtime selection.
 *
 * Selection is by `settings:paymentProvider` (plugin KV), defaulting to
 * "stripe" for backwards compatibility.
 */

import type { PaymentProvider } from "./types";
import { stripePaymentProvider } from "./stripe-provider";

export type PaymentProviderId = "stripe" | "paystack" | "mock" | string;

const registry = new Map<string, PaymentProvider>();
registry.set("stripe", stripePaymentProvider);

export interface RegisterProviderOptions {
	/** Explicitly allow replacing an existing registered provider with the same ID. */
	override?: boolean;
}

/**
 * Sibling packages (e.g. @dashcommerce/paystack) register themselves here at import
 * time so core maintains no hard dependency on external gateway implementations.
 *
 * Rejects empty IDs and duplicate registrations unless { override: true } is explicitly passed.
 */
export function registerPaymentProvider(
	provider: PaymentProvider,
	options: RegisterProviderOptions = {},
): void {
	if (!provider || !provider.id || provider.id.trim() === "") {
		throw new Error("Cannot register a payment provider with an empty ID");
	}
	if (registry.has(provider.id) && !options.override) {
		throw new Error(
			`Payment provider "${provider.id}" is already registered. Pass { override: true } to replace it.`,
		);
	}
	registry.set(provider.id, provider);
}

export function getPaymentProvider(id: string): PaymentProvider | undefined {
	return registry.get(id);
}

export function listPaymentProviders(): PaymentProvider[] {
	return Array.from(registry.values());
}

/** Test utility: reset registry to initial default state containing only stripe. */
export function resetPaymentProviders(): void {
	registry.clear();
	registry.set("stripe", stripePaymentProvider);
}

interface KVLike {
	get<T>(key: string): Promise<T | null>;
}

const DEFAULT_PROVIDER_ID = "stripe";

/** Resolve the active provider for this deployment from plugin KV. Falls
 * back to "stripe" (upstream's default) if unset, and throws a clear
 * error if the configured id was never registered rather than silently no-op-ing. */
export async function resolveProvider(kv: KVLike): Promise<PaymentProvider> {
	const configured = (await kv.get<string>("settings:paymentProvider")) ?? DEFAULT_PROVIDER_ID;
	const provider = registry.get(configured);
	if (!provider) {
		throw new Error(
			`dashcommerce: settings:paymentProvider is "${configured}" but no PaymentProvider with that id is registered. ` +
				`Registered: ${Array.from(registry.keys()).join(", ") || "(none)"}.`,
		);
	}
	return provider;
}
