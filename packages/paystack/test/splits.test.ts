/**
 * Multi-vendor payments with Paystack: core's exact per-vendor shares become
 * a flat split on the payment, vendors get Paystack subaccounts (banks, and
 * M-PESA in Kenya), and `charge.success` reports what each party was paid.
 */

import { describe, expect, it } from "bun:test";
import type {
	InitCheckoutInput,
	PaymentProviderRuntimeContext,
} from "@dashcommerce/core/payment-provider";
import { paystackPaymentProvider } from "../src/provider";

const credentials = { secretKey: "sk_test_1234567890abcdef" };

function paystackOk(data: unknown, meta?: Record<string, unknown>): Response {
	return new Response(
		JSON.stringify({ status: true, message: "ok", data, ...(meta ? { meta } : {}) }),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

/** Records every request and answers from `respond`. */
function recorder(respond: (url: URL, body: Record<string, unknown> | null) => Response) {
	const calls: Array<{ method: string; url: URL; body: Record<string, unknown> | null }> = [];
	const ctx: PaymentProviderRuntimeContext = {
		http: {
			fetch: async (url: string, init?: RequestInit) => {
				const parsed = new URL(url);
				const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
				calls.push({ method: init?.method ?? "GET", url: parsed, body });
				return respond(parsed, body);
			},
		},
		log: { info() {}, warn() {}, error() {} },
	};
	return { ctx, calls };
}

function checkoutInput(overrides: Partial<InitCheckoutInput> = {}): InitCheckoutInput {
	return {
		orderDraftId: "0123456789abcdef0123456789abcdef",
		amount: 450000,
		currency: "KES",
		customer: { email: "fan@example.com" },
		lineItems: [],
		successUrl: "https://shop.example/thank-you",
		cancelUrl: "https://shop.example/checkout",
		...overrides,
	};
}

const initialised = () =>
	paystackOk({
		authorization_url: "https://checkout.paystack.com/abc",
		access_code: "abc",
		reference: "dc-0123456789abcdef0123456789abcdef",
	});

describe("split at checkout", () => {
	it("declares splits", () => {
		expect(paystackPaymentProvider.capabilities?.splits).toBe(true);
	});

	it("sends core's shares as a flat split, with Paystack's fee on the shop", async () => {
		const { ctx, calls } = recorder(() => initialised());
		await paystackPaymentProvider.initCheckout(
			ctx,
			checkoutInput({
				allocations: [
					{ vendorId: "v1", accountReference: "ACCT_vendorone", amountMinor: 135000 },
					{ vendorId: "v2", accountReference: "ACCT_vendortwo", amountMinor: 135000 },
				],
				platformRemainderMinor: 180000,
			}),
			credentials,
		);
		expect(calls[0]?.body?.split).toEqual({
			type: "flat",
			bearer_type: "account",
			subaccounts: [
				{ subaccount: "ACCT_vendorone", share: 135000 },
				{ subaccount: "ACCT_vendortwo", share: 135000 },
			],
		});
		expect(calls[0]?.body?.amount).toBe(450000);
	});

	it("sends no split for a cart without vendor items", async () => {
		const { ctx, calls } = recorder(() => initialised());
		await paystackPaymentProvider.initCheckout(ctx, checkoutInput(), credentials);
		expect(calls[0]?.body).not.toHaveProperty("split");
	});

	it("refuses shares that exceed the amount, a missing subaccount or a non-positive share, before calling Paystack", async () => {
		const { ctx, calls } = recorder(() => initialised());
		const tryWith = (allocations: InitCheckoutInput["allocations"]) =>
			paystackPaymentProvider.initCheckout(ctx, checkoutInput({ allocations }), credentials);
		await expect(
			tryWith([{ vendorId: "v1", accountReference: "ACCT_a", amountMinor: 450001 }]),
		).rejects.toThrow(/exceed the checkout amount/);
		await expect(
			tryWith([{ vendorId: "v1", accountReference: " ", amountMinor: 100 }]),
		).rejects.toThrow(/no Paystack subaccount code/);
		await expect(
			tryWith([{ vendorId: "v1", accountReference: "ACCT_a", amountMinor: 0 }]),
		).rejects.toThrow(/positive integer/);
		expect(calls).toHaveLength(0);
	});
});

describe("split settlement from charge.success", () => {
	const chargeWithSplit = (split: unknown) =>
		JSON.stringify({
			event: "charge.success",
			data: {
				id: 1,
				reference: "dc-0123456789abcdef0123456789abcdef",
				amount: 450000,
				currency: "KES",
				status: "success",
				customer: { email: "fan@example.com" },
				metadata: { orderDraftId: "0123456789abcdef0123456789abcdef" },
				split,
			},
		});

	it("reports each subaccount's amount, the shop's remainder and Paystack's fee", () => {
		const parsed = paystackPaymentProvider.parseWebhookEvent(
			chargeWithSplit({
				split_code: "SPL_dynamic",
				shares: {
					paystack: 6750,
					integration: 173250,
					subaccounts: [
						{ amount: 135000, subaccount_code: "ACCT_vendorone", id: 1 },
						{ amount: 135000, subaccount_code: "ACCT_vendortwo", id: 2 },
					],
				},
			}),
		);
		if (parsed.type !== "charge.succeeded") throw new Error("expected charge.succeeded");
		expect(parsed.splitSettlement).toMatchObject({
			allocations: [
				{ accountReference: "ACCT_vendorone", amountMinor: 135000 },
				{ accountReference: "ACCT_vendortwo", amountMinor: 135000 },
			],
			platformRemainderMinor: 173250,
			providerFeeMinor: 6750,
			currency: "KES",
		});
	});

	it("reports nothing for a payment without a split", () => {
		const parsed = paystackPaymentProvider.parseWebhookEvent(chargeWithSplit(undefined));
		if (parsed.type !== "charge.succeeded") throw new Error("expected charge.succeeded");
		expect(parsed.splitSettlement).toBeUndefined();
	});
});

describe("vendor payout onboarding", () => {
	const balanceIn = (...currencies: string[]) =>
		paystackOk(currencies.map((currency) => ({ currency, balance: 0 })));

	it("lists a Kenyan shop's banks and mobile money together, once each, following Paystack's pages", async () => {
		const { ctx, calls } = recorder((url) => {
			if (url.pathname === "/balance") return balanceIn("KES", "USD");
			if (url.searchParams.get("type") === "mobile_money") {
				expect(url.searchParams.get("currency")).toBe("KES");
				return paystackOk(
					[
						{ code: "MPESA", name: "M-PESA", active: true },
						{ code: "ATL_KE", name: "Airtel Kenya", active: true },
					],
					{ next: null },
				);
			}
			if (!url.searchParams.get("next")) {
				return paystackOk(
					[
						{ code: "03", name: "Absa Bank Kenya Plc", active: true },
						{ code: "99", name: "Closed Bank", active: false },
					],
					{ next: "page2" },
				);
			}
			return paystackOk(
				[
					{ code: "68", name: "Equity Bank Kenya Limited", active: true },
					{ code: "03", name: "Absa Bank Kenya Plc", active: true },
				],
				{ next: null },
			);
		});
		const banks = await paystackPaymentProvider.listPayoutBanks?.(ctx, "ke", credentials);
		expect(banks).toEqual([
			{ code: "03", name: "Absa Bank Kenya Plc" },
			{ code: "68", name: "Equity Bank Kenya Limited" },
			{ code: "MPESA", name: "M-PESA" },
			{ code: "ATL_KE", name: "Airtel Kenya" },
		]);
		expect(
			calls.map((c) =>
				c.url.pathname === "/balance"
					? "balance"
					: (c.url.searchParams.get("country") ?? c.url.searchParams.get("type")),
			),
		).toEqual(["balance", "kenya", "kenya", "mobile_money"]);
	});

	it("asks for mobile money in the shop's own currency, so a Ghanaian shop gets MTN and the rest", async () => {
		const { ctx } = recorder((url) => {
			if (url.pathname === "/balance") return balanceIn("GHS");
			if (url.searchParams.get("type") === "mobile_money") {
				expect(url.searchParams.get("currency")).toBe("GHS");
				return paystackOk([{ code: "MTN", name: "MTN", active: true }], { next: null });
			}
			return paystackOk([{ code: "GCB", name: "GCB Bank", active: true }], { next: null });
		});
		expect(await paystackPaymentProvider.listPayoutBanks?.(ctx, "GH", credentials)).toEqual([
			{ code: "GCB", name: "GCB Bank" },
			{ code: "MTN", name: "MTN" },
		]);
	});

	it("refuses a vendor country outside the shop's Paystack country, before listing banks", async () => {
		const { ctx, calls } = recorder((url) =>
			url.pathname === "/balance" ? balanceIn("KES", "USD") : paystackOk([], { next: null }),
		);
		await expect(paystackPaymentProvider.listPayoutBanks?.(ctx, "NG", credentials)).rejects.toThrow(
			"This Paystack account pays vendors in Kenya only. Choose KE as the vendor's country.",
		);
		expect(calls.map((c) => c.url.pathname)).toEqual(["/balance"]);
		await expect(paystackPaymentProvider.listPayoutBanks?.(ctx, "UG", credentials)).rejects.toThrow(
			/GH, KE, NG, ZA only/,
		);
	});

	it("doesn't restrict when the key can't read the balance; Paystack still checks the country itself", async () => {
		const { ctx } = recorder((url) =>
			url.pathname === "/balance"
				? new Response(JSON.stringify({ status: false, message: "Forbidden" }), { status: 403 })
				: paystackOk([{ code: "058", name: "GTBank", active: true }], { next: null }),
		);
		expect(await paystackPaymentProvider.listPayoutBanks?.(ctx, "NG", credentials)).toEqual([
			{ code: "058", name: "GTBank" },
		]);
	});

	it("looks up the account holder's name", async () => {
		const { ctx, calls } = recorder(() => paystackOk({ account_name: "VENDOR ONE LTD" }));
		const result = await paystackPaymentProvider.resolvePayoutAccount?.(
			ctx,
			{ accountNumber: " 0123456789 ", bankCode: "03" },
			credentials,
		);
		expect(result).toEqual({ accountName: "VENDOR ONE LTD" });
		expect(calls[0]?.url.pathname).toBe("/bank/resolve");
		expect(calls[0]?.url.searchParams.get("account_number")).toBe("0123456789");
		expect(calls[0]?.url.searchParams.get("bank_code")).toBe("03");
	});

	it("creates a subaccount and returns only a masked account number", async () => {
		const { ctx, calls } = recorder((url) =>
			url.pathname === "/balance"
				? balanceIn("KES")
				: paystackOk({
						subaccount_code: "ACCT_vendorone",
						account_name: "VENDOR ONE LTD",
						settlement_bank: "Absa Bank Kenya Plc",
					}),
		);
		const created = await paystackPaymentProvider.createPayoutAccount?.(
			ctx,
			{
				accountNumber: "0123456789",
				bankCode: "03",
				country: "ke",
				businessName: "Vendor One",
				businessEmail: "one@example.com",
				businessMobile: "+254700000000",
				splitType: "percentage",
				splitValue: 0.1,
			},
			credentials,
		);
		expect(calls.map((c) => c.url.pathname)).toEqual(["/balance", "/subaccount"]);
		expect(calls[1]?.body).toEqual({
			business_name: "Vendor One",
			settlement_bank: "03",
			account_number: "0123456789",
			percentage_charge: 10,
			primary_contact_email: "one@example.com",
			primary_contact_phone: "+254700000000",
		});
		expect(created).toEqual({
			accountReference: "ACCT_vendorone",
			accountName: "VENDOR ONE LTD",
			bankName: "Absa Bank Kenya Plc",
			bankCode: "03",
			country: "KE",
			maskedAccountNumber: "****6789",
		});
	});

	it("refuses a subaccount in another country before calling Paystack to create it", async () => {
		const { ctx, calls } = recorder((url) =>
			url.pathname === "/balance" ? balanceIn("KES") : paystackOk({}),
		);
		await expect(
			paystackPaymentProvider.createPayoutAccount?.(
				ctx,
				{
					accountNumber: "0123456789",
					bankCode: "058",
					country: "NG",
					businessName: "Vendor Two",
					businessEmail: "two@example.com",
					businessMobile: "+2348000000000",
				},
				credentials,
			),
		).rejects.toThrow(/pays vendors in Kenya only/);
		expect(calls.map((c) => c.url.pathname)).toEqual(["/balance"]);
	});

	it("refuses a flat default split, since Paystack subaccounts take a percentage", async () => {
		const { ctx, calls } = recorder(() => paystackOk({}));
		await expect(
			paystackPaymentProvider.createPayoutAccount?.(
				ctx,
				{
					accountNumber: "0123456789",
					bankCode: "03",
					country: "KE",
					businessName: "Vendor One",
					businessEmail: "one@example.com",
					businessMobile: "+254700000000",
					splitType: "flat",
					splitValue: 500,
				},
				credentials,
			),
		).rejects.toThrow(/percentage default/);
		expect(calls).toHaveLength(0);
	});
});
