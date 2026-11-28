/**
 * The worldwide checkout matrix: one shop shape per country, driven through
 * the real cart and checkout routes. Each row checks the closest rate for a
 * detailed address, the country-wide rate for an address with no detail,
 * that pickup on the country zone stays on offer, that a method priced in
 * another currency stays hidden, and that the total sent to the payment
 * provider equals the total the shopper was shown.
 *
 * Then: currency switching re-quotes, JPY stays in whole yen, and tax is
 * unchanged by the new location fields.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import { format } from "../src/money";
import {
	type InitCheckoutInput,
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import sandbox from "../src/sandbox-entry";
import type {
	CartState,
	ShippingMethod,
	ShippingZone,
	ShippingZoneLocation,
	TaxRate,
} from "../src/types";
import { makeRouteContext } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

type Routes = Record<string, { handler: (r: RouteContext, c: PluginContext) => unknown }>;
const routes = sandbox.routes as unknown as Routes;

/** The parcel's price in each matrix currency, in minor units (JPY has none). */
const PARCEL: Record<string, number> = {
	KES: 100_000,
	NGN: 1_000_000,
	USD: 2_000,
	GBP: 1_500,
	EUR: 1_800,
	CAD: 2_500,
	AUD: 2_800,
	INR: 150_000,
	AED: 7_000,
	JPY: 3_000,
};

function zone(id: string, locations: ShippingZoneLocation[], order = 0): ShippingZone {
	return {
		id,
		name: id,
		locations,
		order,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

function flat(id: string, zoneId: string, currency: string, amount: number): ShippingMethod {
	return {
		id,
		zoneId,
		type: "flat_rate",
		title: id,
		enabled: true,
		config: { type: "flat_rate", amount: { amount, currency } },
		order: 0,
	};
}

function pickup(id: string, zoneId: string): ShippingMethod {
	return {
		id,
		zoneId,
		type: "local_pickup",
		title: "Collect from the shop",
		enabled: true,
		config: { type: "local_pickup", pickup: { location: "The shop" } },
		order: 0,
	};
}

const MOCK = {
	"settings:paymentProvider": "mock",
	"settings:checkoutMode": "hosted",
	"settings:mockSecretKey": "k",
	"settings:mockWebhookSecret": "test-secret",
};

function shop(zones: ShippingZone[], methods: ShippingMethod[], kv: Record<string, unknown> = {}) {
	const h = makeRouteContext({ ...MOCK, ...kv });
	h.products.set("prod_parcel", {
		id: "prod_parcel",
		status: "published",
		data: {
			title: "Parcel",
			type: "simple",
			prices: Object.fromEntries(Object.entries(PARCEL).map(([c, amount]) => [c, { amount }])),
			manage_stock: false,
		},
	});
	for (const z of zones) h.getCol("shipping_zones").set(z.id, z as unknown as Record<string, unknown>);
	for (const m of methods)
		h.getCol("shipping_methods").set(m.id, m as unknown as Record<string, unknown>);
	const call = async (path: string, sessionId: string, input?: unknown) => {
		const request = new Request(`http://test/${path}`, {
			method: input === undefined ? "GET" : "POST",
			headers: { Cookie: `dashcommerce_sid=${sessionId}` },
		});
		const routeCtx = { ...(h.ctx as object), request, input } as unknown as RouteContext;
		const res = (await routes[path].handler(routeCtx, h.ctx)) as Response;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	};
	return { ...h, call };
}
type Shop = ReturnType<typeof shop>;

/** A cart in `currency` holding the parcel, or empty. */
async function newCart(s: Shop, currency: string, withParcel = true): Promise<string> {
	const sessionId = `sess_${Math.random()}`;
	expect((await s.call("cart/currency", sessionId, { currency })).status).toBe(200);
	if (withParcel) {
		const added = await s.call("cart/items", sessionId, { productId: "prod_parcel", quantity: 1 });
		expect(added.status).toBe(200);
	}
	return sessionId;
}

/** Options as `[methodId, amount]`, sorted by id. */
async function optionsFor(s: Shop, sessionId: string) {
	const res = await s.call("cart/shipping-methods", sessionId);
	const options = res.body.options as Array<{ methodId: string; amount: { amount: number; currency: string } }>;
	return options.map((o) => [o.methodId, o.amount.amount] as const).sort((a, b) => a[0].localeCompare(b[0]));
}

async function quote(s: Shop, currency: string, location: Record<string, unknown>) {
	const sessionId = await newCart(s, currency);
	const loc = await s.call("cart/shipping-location", sessionId, location);
	expect(loc.status).toBe(200);
	return { sessionId, options: await optionsFor(s, sessionId) };
}

/**
 * Choose `methodId`, give the details a provider without its own address
 * page needs, start checkout, and return what was shown and what was sent.
 */
async function pay(
	s: Shop,
	sessionId: string,
	methodId: string,
	currency: string,
	location: Record<string, unknown>,
	postalCode?: string,
) {
	let sent: InitCheckoutInput | undefined;
	const base = createMockPaymentProvider({ id: "mock", supportedCurrencies: [currency] });
	registerPaymentProvider(
		{
			...base,
			async initCheckout(ctx, input) {
				sent = input;
				return base.initCheckout(ctx, input);
			},
		},
		{ override: true },
	);
	const chosen = await s.call("cart/shipping-method", sessionId, { methodId });
	expect(chosen.status).toBe(200);
	const address = {
		firstName: "Sam",
		lastName: "Shopper",
		line1: "1 High Street",
		city: typeof location.area === "string" && location.area ? location.area : "Town",
		region: typeof location.region === "string" ? location.region : "",
		postalCode: postalCode ?? (typeof location.postalCode === "string" ? location.postalCode : ""),
		country: location.country as string,
	};
	const contact = await s.call("cart/contact", sessionId, {
		email: "shopper@example.com",
		billingAddress: address,
		shippingAddress: address,
		...(typeof location.area === "string" ? { area: location.area } : {}),
	});
	expect(contact.status).toBe(200);
	const shown = (contact.body.cart as CartState).total;
	const res = await s.call("checkout/create-session", sessionId, {});
	expect(res.status).toBe(200);
	return { shown, sent, cart: contact.body.cart as CartState };
}

interface Row {
	country: string;
	currency: string;
	/** A currency no method here is priced in, so its method must stay hidden. */
	foreign: string;
	zones: ShippingZone[];
	rates: ShippingMethod[];
	/** The country-wide rate's id. */
	countryRate: string;
	cases: Array<{ location: Record<string, unknown>; rate: string; amount: number }>;
}

const ROWS: Row[] = [
	{
		country: "KE",
		currency: "KES",
		foreign: "USD",
		zones: [
			zone("ke", [{ country: "KE" }]),
			zone("nbo", [{ country: "KE", regions: ["30"] }]),
			zone("west", [{ country: "KE", regions: ["30"], areas: ["Westlands"] }]),
		],
		rates: [flat("r_west", "west", "KES", 20_000), flat("r_nbo", "nbo", "KES", 30_000), flat("r_ke", "ke", "KES", 50_000)],
		countryRate: "r_ke",
		cases: [
			{ location: { country: "KE", region: "30", area: "Westlands" }, rate: "r_west", amount: 20_000 },
			{ location: { country: "KE", region: "KE-30", area: "  westlands " }, rate: "r_west", amount: 20_000 },
			{ location: { country: "KE", region: "30", area: "" }, rate: "r_nbo", amount: 30_000 },
			{ location: { country: "KE", region: "30", area: "Karen" }, rate: "r_nbo", amount: 30_000 },
			{ location: { country: "KE", region: "28", area: "Westlands" }, rate: "r_ke", amount: 50_000 },
		],
	},
	{
		country: "NG",
		currency: "NGN",
		foreign: "USD",
		zones: [
			zone("ng", [{ country: "NG" }]),
			zone("lagos", [{ country: "NG", regions: ["LA"] }]),
			zone("lekki", [{ country: "NG", regions: ["LA"], areas: ["Lekki", "Ikeja"] }]),
		],
		rates: [
			flat("r_lekki", "lekki", "NGN", 200_000),
			flat("r_lagos", "lagos", "NGN", 300_000),
			flat("r_ng", "ng", "NGN", 500_000),
		],
		countryRate: "r_ng",
		cases: [
			{ location: { country: "NG", region: "LA", area: "IKEJA" }, rate: "r_lekki", amount: 200_000 },
			{ location: { country: "NG", region: "Lagos", area: "Lekki" }, rate: "r_lekki", amount: 200_000 },
			{ location: { country: "NG", region: "LA", area: "" }, rate: "r_lagos", amount: 300_000 },
			{ location: { country: "NG", region: "FC" }, rate: "r_ng", amount: 500_000 },
		],
	},
	{
		country: "US",
		currency: "USD",
		foreign: "EUR",
		zones: [
			zone("us", [{ country: "US" }]),
			zone("ca", [{ country: "US", regions: ["CA"] }]),
			zone("ca_south", [{ country: "US", regions: ["CA"], postcodes: ["90000-96199"] }]),
		],
		rates: [flat("r_ca_south", "ca_south", "USD", 500), flat("r_ca", "ca", "USD", 800), flat("r_us", "us", "USD", 1_200)],
		countryRate: "r_us",
		cases: [
			{ location: { country: "US", region: "CA", postalCode: "94105" }, rate: "r_ca_south", amount: 500 },
			{ location: { country: "US", region: "CA" }, rate: "r_ca", amount: 800 },
			{ location: { country: "US", region: "CA", postalCode: "97201" }, rate: "r_ca", amount: 800 },
			{ location: { country: "US", region: "NY", postalCode: "10001" }, rate: "r_us", amount: 1_200 },
		],
	},
	{
		country: "GB",
		currency: "GBP",
		foreign: "USD",
		zones: [zone("gb", [{ country: "GB" }]), zone("central", [{ country: "GB", postcodes: ["SW1 ", "EC1A "] }])],
		rates: [flat("r_central", "central", "GBP", 300), flat("r_gb", "gb", "GBP", 500)],
		countryRate: "r_gb",
		cases: [
			{ location: { country: "GB", postalCode: "EC1A 1BB" }, rate: "r_central", amount: 300 },
			{ location: { country: "GB", postalCode: "sw1 2aa" }, rate: "r_central", amount: 300 },
			// SW10 is not SW1: the trailing space makes the entry an exact outward code.
			{ location: { country: "GB", postalCode: "SW10 1AA" }, rate: "r_gb", amount: 500 },
			{ location: { country: "GB", postalCode: "EC1A1BB" }, rate: "r_central", amount: 300 },
		],
	},
	{
		country: "PT",
		currency: "EUR",
		foreign: "USD",
		zones: [zone("pt", [{ country: "PT" }]), zone("lisbon", [{ country: "PT", postcodes: ["1000-1999"] }])],
		rates: [flat("r_lisbon", "lisbon", "EUR", 500), flat("r_pt", "pt", "EUR", 900)],
		countryRate: "r_pt",
		cases: [
			{ location: { country: "PT", postalCode: "1100-148" }, rate: "r_lisbon", amount: 500 },
			{ location: { country: "PT", postalCode: "4000-322" }, rate: "r_pt", amount: 900 },
		],
	},
	{
		country: "DE",
		currency: "EUR",
		foreign: "USD",
		zones: [zone("de", [{ country: "DE" }]), zone("berlin", [{ country: "DE", postcodes: ["10"] }])],
		rates: [flat("r_berlin", "berlin", "EUR", 400), flat("r_de", "de", "EUR", 600)],
		countryRate: "r_de",
		cases: [
			{ location: { country: "DE", postalCode: "10115" }, rate: "r_berlin", amount: 400 },
			{ location: { country: "DE", postalCode: "80331" }, rate: "r_de", amount: 600 },
		],
	},
	{
		country: "CA",
		currency: "CAD",
		foreign: "USD",
		zones: [
			zone("ca", [{ country: "CA" }]),
			zone("on", [{ country: "CA", regions: ["ON"] }]),
			zone("toronto", [{ country: "CA", regions: ["ON"], postcodes: ["M5V"] }]),
		],
		rates: [flat("r_toronto", "toronto", "CAD", 600), flat("r_on", "on", "CAD", 900), flat("r_ca", "ca", "CAD", 1_400)],
		countryRate: "r_ca",
		cases: [
			{ location: { country: "CA", region: "ON", postalCode: "M5V 3L9" }, rate: "r_toronto", amount: 600 },
			{ location: { country: "CA", region: "Ontario", postalCode: "K1A 0B1" }, rate: "r_on", amount: 900 },
			{ location: { country: "CA", region: "ON" }, rate: "r_on", amount: 900 },
			{ location: { country: "CA", region: "BC", postalCode: "V6B 1A1" }, rate: "r_ca", amount: 1_400 },
		],
	},
	{
		country: "AU",
		currency: "AUD",
		foreign: "USD",
		zones: [zone("au", [{ country: "AU" }]), zone("sydney", [{ country: "AU", regions: ["NSW"], postcodes: ["2000-2234"] }])],
		rates: [flat("r_sydney", "sydney", "AUD", 700), flat("r_au", "au", "AUD", 1_200)],
		countryRate: "r_au",
		cases: [
			{ location: { country: "AU", region: "NSW", postalCode: "2000" }, rate: "r_sydney", amount: 700 },
			{ location: { country: "AU", region: "NSW", postalCode: "2500" }, rate: "r_au", amount: 1_200 },
			{ location: { country: "AU", region: "NSW" }, rate: "r_au", amount: 1_200 },
		],
	},
	{
		country: "IN",
		currency: "INR",
		foreign: "USD",
		zones: [zone("in", [{ country: "IN" }]), zone("mumbai", [{ country: "IN", regions: ["MH"], postcodes: ["400"] }])],
		rates: [flat("r_mumbai", "mumbai", "INR", 5_000), flat("r_in", "in", "INR", 12_000)],
		countryRate: "r_in",
		cases: [
			{ location: { country: "IN", region: "MH", postalCode: "400001" }, rate: "r_mumbai", amount: 5_000 },
			{ location: { country: "IN", region: "Maharashtra", postalCode: "411001" }, rate: "r_in", amount: 12_000 },
			{ location: { country: "IN", region: "MH" }, rate: "r_in", amount: 12_000 },
		],
	},
	{
		country: "AE",
		currency: "AED",
		foreign: "USD",
		zones: [zone("ae", [{ country: "AE" }]), zone("dubai", [{ country: "AE", regions: ["DU"], areas: ["Dubai Marina", "Downtown"] }])],
		rates: [flat("r_dubai", "dubai", "AED", 1_500), flat("r_ae", "ae", "AED", 3_000)],
		countryRate: "r_ae",
		cases: [
			{ location: { country: "AE", region: "DU", area: "dubai  marina" }, rate: "r_dubai", amount: 1_500 },
			{ location: { country: "AE", region: "Dubai", area: "Downtown" }, rate: "r_dubai", amount: 1_500 },
			{ location: { country: "AE", region: "DU", area: "" }, rate: "r_ae", amount: 3_000 },
			{ location: { country: "AE", region: "SH", area: "Downtown" }, rate: "r_ae", amount: 3_000 },
		],
	},
	{
		country: "JP",
		currency: "JPY",
		foreign: "USD",
		zones: [zone("jp", [{ country: "JP" }]), zone("tokyo", [{ country: "JP", regions: ["13"] }])],
		rates: [flat("r_tokyo", "tokyo", "JPY", 500), flat("r_jp", "jp", "JPY", 1_000)],
		countryRate: "r_jp",
		cases: [
			{ location: { country: "JP", region: "13" }, rate: "r_tokyo", amount: 500 },
			{ location: { country: "JP", region: "Tokyo" }, rate: "r_tokyo", amount: 500 },
			{ location: { country: "JP", region: "27" }, rate: "r_jp", amount: 1_000 },
		],
	},
	{
		country: "IE",
		currency: "EUR",
		foreign: "USD",
		zones: [zone("ie", [{ country: "IE" }])],
		rates: [flat("r_ie", "ie", "EUR", 600)],
		countryRate: "r_ie",
		cases: [
			{ location: { country: "IE", postalCode: "D02 X285" }, rate: "r_ie", amount: 600 },
			{ location: { country: "IE", postalCode: "" }, rate: "r_ie", amount: 600 },
		],
	},
];

function rowShop(row: Row) {
	const countryZone = row.zones[0];
	if (!countryZone) throw new Error("row has no zones");
	return shop(row.zones, [
		...row.rates,
		pickup("pickup", countryZone.id),
		// Priced only in another currency: never offered in this row.
		flat("r_foreign", countryZone.id, row.foreign, 999),
	]);
}

describe("the checkout location matrix", () => {
	for (const row of ROWS) {
		describe(`${row.country} (${row.currency})`, () => {
			for (const c of row.cases) {
				it(`${JSON.stringify(c.location)} gets ${c.rate}, pickup, and not the ${row.foreign} method`, async () => {
					const { options } = await quote(rowShop(row), row.currency, c.location);
					expect(options).toEqual(
						[
							[c.rate, c.amount] as const,
							["pickup", 0] as const,
						].sort((a, b) => a[0].localeCompare(b[0])),
					);
				});
			}

			it("gives an address with no detail the country-wide rate and pickup", async () => {
				const countryWide = row.rates.find((r) => r.id === row.countryRate);
				const amount = countryWide?.config.type === "flat_rate" ? countryWide.config.amount.amount : -1;
				const { options } = await quote(rowShop(row), row.currency, { country: row.country });
				expect(options).toEqual(
					[[row.countryRate, amount] as const, ["pickup", 0] as const].sort((a, b) =>
						a[0].localeCompare(b[0]),
					),
				);
			});

			it("sends the provider the total the shopper was shown", async () => {
				const s = rowShop(row);
				const first = row.cases[0];
				if (!first) throw new Error("row has no cases");
				const { sessionId } = await quote(s, row.currency, first.location);
				const { shown, sent, cart } = await pay(s, sessionId, first.rate, row.currency, first.location);
				expect(cart.shippingMethod?.id).toBe(first.rate);
				expect(shown).toEqual({ amount: (PARCEL[row.currency] ?? 0) + first.amount, currency: row.currency });
				expect(sent?.amount).toBe(shown.amount);
				expect(sent?.currency).toBe(row.currency);
			});
		});
	}
});

describe("pickup on the country zone", () => {
	it("can be chosen and paid for from an area or postcode zone", async () => {
		const row = ROWS[0];
		if (!row) throw new Error("no rows");
		const s = rowShop(row);
		const location = { country: "KE", region: "30", area: "Westlands" };
		const { sessionId } = await quote(s, "KES", location);
		const { sent, cart } = await pay(s, sessionId, "pickup", "KES", location);
		expect(cart.shippingMethod?.pickup).toEqual({ location: "The shop" });
		expect(sent?.amount).toBe(PARCEL.KES);
	});
});

describe("currency", () => {
	const keShop = () =>
		shop(
			[zone("ke", [{ country: "KE" }])],
			[flat("r_kes", "ke", "KES", 50_000), flat("r_usd", "ke", "USD", 400), pickup("pickup", "ke")],
		);

	it("re-quotes shipping when the shop currency switches between KES and USD", async () => {
		const s = keShop();
		const sessionId = await newCart(s, "KES", false);
		await s.call("cart/shipping-location", sessionId, { country: "KE" });
		expect(await optionsFor(s, sessionId)).toEqual([
			["pickup", 0],
			["r_kes", 50_000],
		]);
		const chosen = await s.call("cart/shipping-method", sessionId, { methodId: "r_kes" });
		expect(chosen.status).toBe(200);

		const usd = await s.call("cart/currency", sessionId, { currency: "USD" });
		expect((usd.body.cart as CartState).shippingMethod).toBeUndefined();
		expect(await optionsFor(s, sessionId)).toEqual([
			["pickup", 0],
			["r_usd", 400],
		]);

		await s.call("cart/currency", sessionId, { currency: "KES" });
		expect(await optionsFor(s, sessionId)).toEqual([
			["pickup", 0],
			["r_kes", 50_000],
		]);
	});

	it("keeps JPY in whole yen: ¥500 is stored, charged and shown as ¥500", async () => {
		const row = ROWS.find((r) => r.country === "JP");
		if (!row) throw new Error("no JP row");
		const s = rowShop(row);
		const location = { country: "JP", region: "13" };
		const { sessionId } = await quote(s, "JPY", location);
		const { cart, sent } = await pay(s, sessionId, "r_tokyo", "JPY", location);
		expect(cart.shippingMethod?.amount).toEqual({ amount: 500, currency: "JPY" });
		expect(cart.shippingTotal).toEqual({ amount: 500, currency: "JPY" });
		expect(sent?.amount).toBe(3_500);
		expect(format({ amount: 500, currency: "JPY" }, "en-GB")).toBe("JP¥500");
		expect(format({ amount: 500, currency: "JPY" }, "ja-JP")).toBe("￥500");
	});
});

describe("tax is unchanged by location and areas", () => {
	const VAT: TaxRate = {
		id: "ke-vat",
		country: "KE",
		rate: 16,
		name: "VAT",
		taxClass: "standard",
		compound: false,
		appliesToShipping: false,
		priority: 1,
	};
	// Saved by name: still matches the address's region code 30.
	const LEVY: TaxRate = { ...VAT, id: "nbo-levy", region: "Nairobi", rate: 2, name: "County levy", priority: 2 };

	function taxShop(kv: Record<string, unknown>, rates: TaxRate[] = []) {
		const row = ROWS[0];
		if (!row) throw new Error("no rows");
		const s = shop(row.zones, [...row.rates, pickup("pickup", "ke")], kv);
		for (const r of rates) s.getCol("tax_rates").set(r.id, r as unknown as Record<string, unknown>);
		return s;
	}

	async function taxFor(s: Shop, location: Record<string, unknown>, rate: string) {
		const { sessionId } = await quote(s, "KES", location);
		const chosen = await s.call("cart/shipping-method", sessionId, { methodId: rate });
		expect(chosen.status).toBe(200);
		const cart = chosen.body.cart as CartState;
		return { total: cart.taxTotal.amount, names: cart.taxLines.map((l) => l.label) };
	}

	it("flat tax applies as before, whatever the area", async () => {
		const s = taxShop({ "settings:taxMode": "flat", "settings:flatTaxRatePercent": 16 });
		const west = await taxFor(s, { country: "KE", region: "30", area: "Westlands" }, "r_west");
		const rest = await taxFor(s, { country: "KE", region: "30", area: "" }, "r_nbo");
		expect(west.total).toBe(16_000);
		expect(rest.total).toBe(16_000);
	});

	it("table tax matches by country, and by region code with a rate saved as a name", async () => {
		const s = taxShop({ "settings:taxMode": "table" }, [VAT, LEVY]);
		expect((await taxFor(s, { country: "KE", region: "30" }, "r_nbo")).total).toBe(18_000);
		expect((await taxFor(s, { country: "KE", region: "28" }, "r_ke")).total).toBe(16_000);
	});

	it("an area (stored as the city) never changes the tax", async () => {
		const s = taxShop({ "settings:taxMode": "table" }, [VAT, LEVY]);
		const west = await taxFor(s, { country: "KE", region: "30", area: "Westlands" }, "r_west");
		const karen = await taxFor(s, { country: "KE", region: "30", area: "Karen" }, "r_nbo");
		const none = await taxFor(s, { country: "KE", region: "30" }, "r_nbo");
		expect(west).toEqual(none);
		expect(karen).toEqual(none);
	});

	it("a postcode rate applies once the postcode comes with the address, and is charged", async () => {
		const s = shop([zone("us", [{ country: "US" }])], [flat("r_us", "us", "USD", 1_200)], {
			"settings:taxMode": "table",
		});
		s.getCol("tax_rates").set("sf", {
			id: "sf",
			country: "US",
			postalCode: "941",
			rate: 8,
			name: "City tax",
			taxClass: "standard",
			compound: false,
			appliesToShipping: false,
			priority: 1,
		});
		// No postcode at the quote step: no postcode tax yet.
		const location = { country: "US", region: "CA" };
		const { sessionId } = await quote(s, "USD", location);
		const chosen = await s.call("cart/shipping-method", sessionId, { methodId: "r_us" });
		expect((chosen.body.cart as CartState).taxTotal.amount).toBe(0);
		// The postcode arrives with the full address.
		const { shown, sent, cart } = await pay(s, sessionId, "r_us", "USD", location, "94105");
		expect(cart.taxTotal.amount).toBe(160);
		expect(shown.amount).toBe(2_000 + 1_200 + 160);
		expect(sent?.amount).toBe(shown.amount);
	});
});
