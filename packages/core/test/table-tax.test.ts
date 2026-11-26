/**
 * Table tax: the rates on the admin Tax page apply to the cart and the
 * checkout charge, matched on the order's country, region and postcode.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { RouteContext } from "emdash";
import {
	type InitCheckoutInput,
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import sandbox from "../src/sandbox-entry";
import type { CartState, TaxRate } from "../src/types";
import { makeRouteContext, ticketCart } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

/** The ticket cart is KES 1,500.00, so 16% VAT is KES 240.00. */
const SUBTOTAL = 150000;

function rate(
	overrides: Partial<TaxRate> & Pick<TaxRate, "id" | "country" | "rate" | "name">,
): TaxRate {
	return {
		taxClass: "standard",
		compound: false,
		appliesToShipping: false,
		priority: 1,
		...overrides,
	};
}

const KE_VAT = rate({ id: "ke-vat", country: "KE", rate: 16, name: "VAT" });

function address(overrides: Record<string, string> = {}) {
	return {
		firstName: "Wanjiru",
		lastName: "Kamau",
		line1: "Ngong Road",
		city: "Nairobi",
		region: "",
		postalCode: "",
		country: "KE",
		...overrides,
	};
}

/** A shop in table-tax mode with the given rates, and one cart in it. */
async function shop(rates: TaxRate[], cart: Partial<CartState> = {}) {
	const { ctx } = makeRouteContext({
		"settings:taxMode": "table",
		"settings:paymentProvider": "mock",
		"settings:checkoutMode": "hosted",
		"settings:mockSecretKey": "k",
		"settings:mockWebhookSecret": "test-secret",
	});
	const storage = ctx.storage as unknown as {
		tax_rates: { put(id: string, data: unknown): Promise<void> };
	};
	for (const r of rates) await storage.tax_rates.put(r.id, r);
	const sessionId = `sess_${Math.random()}`;
	await ctx.kv.set(`cart:${sessionId}`, { ...ticketCart(sessionId), ...cart });

	async function call(route: keyof typeof sandbox.routes, input: unknown) {
		const routeCtx = {
			...ctx,
			request: new Request(`http://test/${String(route)}`, {
				method: "POST",
				headers: { Cookie: `dashcommerce_sid=${sessionId}` },
			}),
			input,
		} as unknown as RouteContext;
		const res = (await sandbox.routes[route].handler(routeCtx, ctx)) as Response;
		return {
			status: res.status,
			body: (await res.json()) as { cart: CartState } & Record<string, unknown>,
		};
	}
	return { call };
}

describe("table tax on the cart", () => {
	it("applies the rate for the order's country", async () => {
		const { call } = await shop([KE_VAT]);
		const { body } = await call("cart/contact", {
			shippingAddress: address(),
			billingAddress: address(),
		});
		expect(body.cart.taxLines).toEqual([
			{ label: "VAT", amount: { amount: 24000, currency: "KES" }, rate: 16 },
		]);
		expect(body.cart.taxTotal.amount).toBe(24000);
		expect(body.cart.total.amount).toBe(SUBTOTAL + 24000);
	});

	it("doesn't apply another country's rate", async () => {
		const { call } = await shop([rate({ id: "gb-vat", country: "GB", rate: 20, name: "VAT" })]);
		const { body } = await call("cart/contact", {
			shippingAddress: address(),
			billingAddress: address(),
		});
		expect(body.cart.taxLines).toEqual([]);
		expect(body.cart.total.amount).toBe(SUBTOTAL);
	});

	it("adds a region's rate only for an address in that region", async () => {
		const county = rate({
			id: "nbi",
			country: "KE",
			region: "Nairobi",
			rate: 2,
			name: "County levy",
			priority: 2,
		});
		const { call } = await shop([KE_VAT, county]);

		const inRegion = await call("cart/contact", {
			shippingAddress: address({ region: "Nairobi" }),
		});
		expect(inRegion.body.cart.taxLines.map((l) => l.label)).toEqual(["VAT", "County levy"]);
		expect(inRegion.body.cart.taxTotal.amount).toBe(24000 + 3000);

		const typedLoosely = await call("cart/contact", {
			shippingAddress: address({ region: " nairobi " }),
		});
		expect(typedLoosely.body.cart.taxLines.map((l) => l.label)).toEqual(["VAT", "County levy"]);

		const elsewhere = await call("cart/contact", {
			shippingAddress: address({ region: "Kisumu" }),
		});
		expect(elsewhere.body.cart.taxLines.map((l) => l.label)).toEqual(["VAT"]);
	});

	it("matches a postcode-prefix rate without case or spaces, and only when there is a postcode", async () => {
		const gbVat = rate({ id: "gb-vat", country: "GB", rate: 20, name: "VAT" });
		const levy = rate({
			id: "sw1a",
			country: "GB",
			postalCode: "SW1A",
			rate: 5,
			name: "Levy",
			priority: 2,
		});
		const labelsFor = async (postalCode: string) => {
			const { call } = await shop([gbVat, levy]);
			const london = address({ city: "London", country: "GB", postalCode });
			const { body } = await call("cart/contact", {
				shippingAddress: london,
				billingAddress: london,
			});
			return body.cart.taxLines.map((l) => l.label);
		};
		expect(await labelsFor("sw1a 1aa")).toEqual(["VAT", "Levy"]);
		expect(await labelsFor("E1 6AN")).toEqual(["VAT"]);
		// Before this fix, a postcode-prefix rate applied to every address without a postcode.
		expect(await labelsFor("")).toEqual(["VAT"]);
	});

	it("adds no tax until the cart has an address", async () => {
		const { call } = await shop([KE_VAT], {
			shippingAddress: undefined,
			billingAddress: undefined,
		});
		const { body } = await call("cart/contact", { email: "buyer@example.com" });
		expect(body.cart.taxLines).toEqual([]);
		expect(body.cart.total.amount).toBe(SUBTOTAL);
	});
});

describe("table tax at checkout", () => {
	it("charges the total including the table tax", async () => {
		const mock = createMockPaymentProvider();
		let charged: InitCheckoutInput | undefined;
		registerPaymentProvider({
			...mock,
			async initCheckout(ctx, input) {
				charged = input;
				return mock.initCheckout(ctx, input);
			},
		});
		const { call } = await shop([KE_VAT]);
		await call("cart/contact", { shippingAddress: address(), billingAddress: address() });

		const res = await call("checkout/create-session", {});
		expect(res.status).toBe(200);
		expect(charged?.amount).toBe(SUBTOTAL + 24000);
		expect(charged?.currency).toBe("KES");
	});
});
