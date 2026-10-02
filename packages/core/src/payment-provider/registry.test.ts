// registry.test.ts
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
	registerPaymentProvider,
	getPaymentProvider,
	listPaymentProviders,
	resolveProvider,
	resetPaymentProviders,
} from "./registry";
import { createMockPaymentProvider } from "./mock-provider";
import { stripePaymentProvider } from "./stripe-provider";
import type { PaymentProvider } from "./types";

class FakeKV {
	constructor(private store: Record<string, unknown> = {}) {}
	async get<T>(key: string): Promise<T | null> {
		return (this.store[key] as T) ?? null;
	}
}

test("registry: stripe is registered by default", () => {
	resetPaymentProviders();
	assert.ok(getPaymentProvider("stripe"));
	assert.equal(getPaymentProvider("stripe")?.label, "Stripe");
});

test("registry: registerPaymentProvider adds a new provider without clobbering existing ones", () => {
	resetPaymentProviders();
	const before = listPaymentProviders().length;
	registerPaymentProvider(createMockPaymentProvider());
	assert.ok(getPaymentProvider("mock"));
	assert.ok(listPaymentProviders().length >= before);
	assert.ok(getPaymentProvider("stripe"), "registering mock must not remove stripe");
});

test("registry: rejects duplicate provider registration unless override is explicit", () => {
	resetPaymentProviders();
	const mock1 = createMockPaymentProvider();
	registerPaymentProvider(mock1);

	// Registering same ID without override throws
	const mock2 = createMockPaymentProvider();
	assert.throws(
		() => registerPaymentProvider(mock2),
		/already registered\. Pass \{ override: true \} to replace it/,
	);

	// Registering with override: true replaces it
	const mockReplacement: PaymentProvider = {
		...createMockPaymentProvider(),
		label: "Mock Replacement",
	};
	assert.doesNotThrow(() =>
		registerPaymentProvider(mockReplacement, { override: true }),
	);
	assert.equal(getPaymentProvider("mock")?.label, "Mock Replacement");
});

test("registry: rejects empty or whitespace-only provider IDs", () => {
	resetPaymentProviders();
	assert.throws(
		// @ts-expect-error testing invalid ID
		() => registerPaymentProvider({ id: "", label: "Empty" }),
		/Cannot register a payment provider with an empty ID/,
	);
	assert.throws(
		// @ts-expect-error testing whitespace ID
		() => registerPaymentProvider({ id: "   ", label: "Whitespace" }),
		/Cannot register a payment provider with an empty ID/,
	);
});

test("resolveProvider: defaults to stripe when settings:paymentProvider unset", async () => {
	resetPaymentProviders();
	const kv = new FakeKV();
	const provider = await resolveProvider(kv);
	assert.equal(provider.id, "stripe");
});

test("resolveProvider: honours settings:paymentProvider when set to a registered id", async () => {
	resetPaymentProviders();
	registerPaymentProvider(createMockPaymentProvider());
	const kv = new FakeKV({ "settings:paymentProvider": "mock" });
	const provider = await resolveProvider(kv);
	assert.equal(provider.id, "mock");
});

test("resolveProvider: throws a clear error for an unregistered provider id (never silently no-ops)", async () => {
	resetPaymentProviders();
	const kv = new FakeKV({ "settings:paymentProvider": "flutterwave" });
	await assert.rejects(() => resolveProvider(kv), /flutterwave/);
});

test("stripePaymentProvider: identity + currency policy", () => {
	assert.equal(stripePaymentProvider.id, "stripe");
	assert.equal(stripePaymentProvider.supportsCurrency("KES"), true);
	assert.equal(stripePaymentProvider.supportsCurrency("USD"), true);
	assert.equal(stripePaymentProvider.supportsCurrency("INVALID"), false);
});

test("stripePaymentProvider: formatAmount renders major units with currency code", () => {
	assert.equal(
		stripePaymentProvider.formatAmount({ amount: 150000, currency: "kes" }),
		"KES 1500.00",
	);
});
