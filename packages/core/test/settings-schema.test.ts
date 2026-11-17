import { describe, expect, it } from "bun:test";
import {
	MASKED_SECRET_PREFIX,
	SECRET_SETTINGS_KEYS,
	SETTINGS_KEYS,
	validateSettings,
	validateSettingsKey,
} from "../src/settings/schema";

describe("settings schema — paymentProvider & paystackSecretKey", () => {
	it("includes paymentProvider and paystackSecretKey in canonical keys", () => {
		expect(SETTINGS_KEYS).toContain("paymentProvider");
		expect(SETTINGS_KEYS).toContain("paystackSecretKey");
		expect(SECRET_SETTINGS_KEYS.has("paystackSecretKey")).toBe(true);
	});

	it("validates paymentProvider valid and invalid values", () => {
		const validStripe = validateSettingsKey("paymentProvider", "stripe");
		expect(validStripe.ok).toBe(true);
		if (validStripe.ok) expect(validStripe.value).toBe("stripe");

		const validPaystack = validateSettingsKey("paymentProvider", "paystack");
		expect(validPaystack.ok).toBe(true);
		if (validPaystack.ok) expect(validPaystack.value).toBe("paystack");

		const invalidUpper = validateSettingsKey("paymentProvider", "PAYSTACK");
		expect(invalidUpper.ok).toBe(false);

		const invalidEmpty = validateSettingsKey("paymentProvider", "");
		expect(invalidEmpty.ok).toBe(false);
	});

	it("validates paystackSecretKey prefix requirements", () => {
		const testKey = validateSettingsKey("paystackSecretKey", "sk_test_1234567890abcdef");
		expect(testKey.ok).toBe(true);
		if (testKey.ok) expect(testKey.value).toBe("sk_test_1234567890abcdef");

		const liveKey = validateSettingsKey("paystackSecretKey", "sk_live_1234567890abcdef");
		expect(liveKey.ok).toBe(true);
		if (liveKey.ok) expect(liveKey.value).toBe("sk_live_1234567890abcdef");

		const invalidKey = validateSettingsKey("paystackSecretKey", "invalid_prefix_key");
		expect(invalidKey.ok).toBe(false);

		const stripeKey = validateSettingsKey("paystackSecretKey", "pk_test_1234567890abcdef");
		expect(stripeKey.ok).toBe(false);
	});

	it("validateSettings drops masked paystackSecretKey without overwriting", () => {
		const report = validateSettings({
			paymentProvider: "paystack",
			paystackSecretKey: `${MASKED_SECRET_PREFIX}abcd`,
		});

		expect(report.ok).toBe(true);
		expect(report.values.paymentProvider).toBe("paystack");
		// Secret was masked, so it is silently dropped from payload
		expect("paystackSecretKey" in report.values).toBe(false);
	});

	it("validateSettings includes newly entered paystackSecretKey", () => {
		const report = validateSettings({
			paymentProvider: "paystack",
			paystackSecretKey: "sk_test_9876543210abcdef",
		});

		expect(report.ok).toBe(true);
		expect(report.values.paymentProvider).toBe("paystack");
		expect(report.values.paystackSecretKey).toBe("sk_test_9876543210abcdef");
	});
});
