/**
 * Shipping zones can list postcode prefixes and ranges, so a shop can
 * charge a city rate (Lisbon's 1000–1999) next to a country-wide one.
 * Driven through the real cart and admin routes. Hosted checkout asks for
 * the postcode only in countries where a zone lists postcodes.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PluginContext, RouteContext } from "emdash";
import sandbox from "../src/sandbox-entry";
import { pickZone } from "../src/shipping/calculate";
import { requoteShipping } from "../src/shipping/requote";
import type { Address, CartState, ShippingMethod, ShippingZone } from "../src/types";
import { makeRouteContext, ticketCart } from "./helpers/route-harness";

const kes = (amount: number) => ({ amount, currency: "KES" });

function zone(id: string, name: string, locations: ShippingZone["locations"], order = 0) {
	return {
		id,
		data: {
			id,
			name,
			locations,
			order,
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
		} satisfies ShippingZone,
	};
}

function flatRate(id: string, zoneId: string, title: string, amount: number) {
	return {
		id,
		data: {
			id,
			zoneId,
			type: "flat_rate",
			title,
			enabled: true,
			config: { type: "flat_rate", amount: kes(amount) },
			order: 0,
		} satisfies ShippingMethod,
	};
}

/**
 * Portugal-wide delivery, and Lisbon (postcodes 1000–1999 and the 2600
 * prefix) cheaper. Same order, Portugal stored first: the postcode zone
 * must still win.
 */
const portugalZones = [
	zone("zone_pt", "Portugal", [{ country: "PT" }]),
	zone("zone_lis", "Lisbon", [{ country: "PT", postcodes: ["1000-1999", "2600"] }]),
];
const portugalMethods = [
	flatRate("ship_pt", "zone_pt", "Portugal delivery", 90000),
	flatRate("ship_lis", "zone_lis", "Lisbon delivery", 40000),
];

type Routes = Record<string, { handler: (r: RouteContext, c: PluginContext) => unknown }>;
const routes = sandbox.routes as unknown as Routes;

function shop(zones = portugalZones, methods = portugalMethods) {
	const { ctx, getCol } = makeRouteContext({});
	for (const z of zones) getCol("shipping_zones").set(z.id, z.data);
	for (const m of methods) getCol("shipping_methods").set(m.id, m.data);
	const call = async (path: string, sessionId: string, input?: unknown, method?: string) => {
		const request = new Request(`http://test/${path}`, {
			method: method ?? (input === undefined ? "GET" : "POST"),
			headers: { Cookie: `dashcommerce_sid=${sessionId}` },
		});
		const routeCtx = { ...(ctx as object), request, input } as unknown as RouteContext;
		const res = (await routes[path].handler(routeCtx, ctx)) as Response;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	};
	return { ctx, call };
}

async function newCart(ctx: { kv: { set(k: string, v: unknown): Promise<void> } }) {
	const sessionId = `sess_${Math.random()}`;
	await ctx.kv.set(`cart:${sessionId}`, { ...ticketCart(sessionId), shippingAddress: undefined });
	return sessionId;
}

/** Post the ship-to location in `shop`, then list the rates the cart is offered. */
async function ratesIn(s: ReturnType<typeof shop>, location: Record<string, unknown>) {
	const sessionId = await newCart(s.ctx);
	const loc = await s.call("cart/shipping-location", sessionId, location);
	expect(loc.status).toBe(200);
	const rates = await s.call("cart/shipping-methods", sessionId);
	const options = rates.body.options as Array<{ methodId: string; amount: { amount: number } }>;
	return { sessionId, options: options.map((o) => [o.methodId, o.amount.amount]) };
}

const ratesFor = (location: Record<string, unknown>) => ratesIn(shop(), location);

describe("rates by postcode through the cart routes", () => {
	it("gives a Lisbon postcode in the range the Lisbon rate", async () => {
		expect((await ratesFor({ country: "PT", postalCode: "1100-148" })).options).toEqual([
			["ship_lis", 40000],
		]);
	});

	it("gives a postcode under a plain prefix the Lisbon rate", async () => {
		expect((await ratesFor({ country: "PT", postalCode: "2600-001" })).options).toEqual([
			["ship_lis", 40000],
		]);
	});

	it("gives a Porto postcode the country rate", async () => {
		expect((await ratesFor({ country: "PT", postalCode: "4000-322" })).options).toEqual([
			["ship_pt", 90000],
		]);
	});

	it("includes both ends of a range and nothing either side", async () => {
		const rate = async (postalCode: string) =>
			(await ratesFor({ country: "PT", postalCode })).options[0]?.[0];
		expect(await rate("1000-001")).toBe("ship_lis");
		expect(await rate("1999-999")).toBe("ship_lis");
		expect(await rate("0999-999")).toBe("ship_pt");
		expect(await rate("2000-001")).toBe("ship_pt");
		// Too short to compare with a four-digit range.
		expect(await rate("123")).toBe("ship_pt");
	});

	it("gives a cart without a postcode the country rate", async () => {
		expect((await ratesFor({ country: "PT" })).options).toEqual([["ship_pt", 90000]]);
		expect((await ratesFor({ country: "PT", postalCode: "" })).options).toEqual([
			["ship_pt", 90000],
		]);
	});

	it("matches prefixes without case or spaces", async () => {
		const uk = shop(
			[
				zone("zone_gb", "UK", [{ country: "GB" }]),
				zone("zone_sw1", "Westminster", [{ country: "GB", postcodes: ["SW1"] }]),
			],
			[
				flatRate("ship_gb", "zone_gb", "UK", 9000),
				flatRate("ship_sw1", "zone_sw1", "Courier", 3000),
			],
		);
		expect((await ratesIn(uk, { country: "GB", postalCode: "sw1a 1aa" })).options).toEqual([
			["ship_sw1", 3000],
		]);
		expect((await ratesIn(uk, { country: "GB", postalCode: "SW2 1AA" })).options).toEqual([
			["ship_gb", 9000],
		]);
	});

	it("lets a Lisbon cart choose the Lisbon rate, and not a Porto cart", async () => {
		const s = shop();
		const lisbon = await ratesIn(s, { country: "PT", postalCode: "1100-148" });
		const chosen = await s.call("cart/shipping-method", lisbon.sessionId, { methodId: "ship_lis" });
		expect(chosen.status).toBe(200);
		expect((chosen.body.cart as CartState).shippingMethod?.amount).toEqual(kes(40000));

		const porto = await ratesIn(s, { country: "PT", postalCode: "4000-322" });
		const refused = await s.call("cart/shipping-method", porto.sessionId, { methodId: "ship_lis" });
		expect(refused.status).toBe(409);
	});

	it("re-quotes at checkout: a Lisbon rate is dropped once the postcode is outside Lisbon", async () => {
		const s = shop();
		const { sessionId } = await ratesIn(s, { country: "PT", postalCode: "1100-148" });
		const chosen = await s.call("cart/shipping-method", sessionId, { methodId: "ship_lis" });
		const cart = chosen.body.cart as CartState;
		const ctx = s.ctx as unknown as PluginContext;

		// create-session and create-intent re-quote through `requoteShipping`.
		expect((await requoteShipping(ctx, cart)).shippingMethod?.id).toBe("ship_lis");
		if (!cart.shippingAddress) throw new Error("cart has no ship-to address");
		const moved = { ...cart, shippingAddress: { ...cart.shippingAddress, postalCode: "4000-322" } };
		expect((await requoteShipping(ctx, moved)).shippingMethod).toBeUndefined();
	});

	it("refuses a postcode that is not short, plain text", async () => {
		const { ctx, call } = shop();
		const sessionId = await newCart(ctx);
		for (const postalCode of [12345, "1".repeat(17), "1000<script>", "1000;DROP"]) {
			const res = await call("cart/shipping-location", sessionId, { country: "PT", postalCode });
			expect(res.status).toBe(400);
			expect(String(res.body.error)).toMatch(/postalCode/);
		}
	});
});

describe("precedence at the same order", () => {
	const address = (region: string, postalCode: string): Address => ({
		firstName: "Wanjiru",
		lastName: "Kamau",
		line1: "Ngong Road",
		city: "Nairobi",
		region,
		postalCode,
		country: "KE",
	});
	const zones = [
		zone("ke", "Kenya", [{ country: "KE" }]).data,
		zone("nbo", "Nairobi", [{ country: "KE", regions: ["30"] }]).data,
		zone("cbd", "Nairobi CBD", [{ country: "KE", postcodes: ["00100"] }]).data,
	];

	it("puts a postcode match before a region match before the whole country", () => {
		expect(pickZone(address("30", "00100"), zones)?.id).toBe("cbd");
		expect(pickZone(address("30", "00500"), zones)?.id).toBe("nbo");
		expect(pickZone(address("31", "20100"), zones)?.id).toBe("ke");
		// Whatever order they are stored in.
		expect(pickZone(address("30", "00100"), [...zones].reverse())?.id).toBe("cbd");
	});

	it("still lets a lower order win over a postcode match", () => {
		const ordered = [zones[0], { ...zones[2], order: 5 }];
		expect(pickZone(address("30", "00100"), ordered)?.id).toBe("ke");
	});

	it("needs both the region and the postcode when a location lists both", () => {
		const both = [
			zone("both", "Both", [{ country: "KE", regions: ["30"], postcodes: ["00100"] }]).data,
		];
		expect(pickZone(address("30", "00100"), both)?.id).toBe("both");
		expect(pickZone(address("31", "00100"), both)).toBeNull();
		expect(pickZone(address("30", "00200"), both)).toBeNull();
	});
});

describe("cart/shipping-regions lists the postcode countries", () => {
	it("names the countries where a zone lists postcodes", async () => {
		const { ctx, call } = shop([
			...portugalZones,
			zone("zone_ke", "Kenya", [{ country: "KE", regions: ["30"] }]),
		]);
		const res = await call("cart/shipping-regions", await newCart(ctx));
		expect(res.body.postcodes).toEqual(["PT"]);
	});

	it("names none when no zone lists postcodes", async () => {
		const { ctx, call } = shop([zone("zone_ke", "Kenya", [{ country: "KE", regions: ["30"] }])]);
		const res = await call("cart/shipping-regions", await newCart(ctx));
		expect(res.body.postcodes).toEqual([]);
	});
});

describe("postcodes in the admin zone routes", () => {
	async function saveZone(locations: unknown) {
		const { call } = shop([], []);
		return call("admin/shipping/zones", "admin", { name: "Lisbon", locations });
	}

	it("stores prefixes and ranges without case, spaces, wildcards or repeats", async () => {
		const res = await saveZone([
			{ country: "PT", postcodes: ["1000-1999", " 2600 ", "sw1*", "1000-1999", ""] },
		]);
		expect(res.status).toBe(201);
		expect((res.body.zone as ShippingZone).locations).toEqual([
			{ country: "PT", postcodes: ["1000-1999", "2600", "SW1"] },
		]);
	});

	it("keeps an existing zone without postcodes as it was", async () => {
		const res = await saveZone([{ country: "KE", regions: ["30"] }, { country: "UG" }]);
		expect(res.status).toBe(201);
		expect((res.body.zone as ShippingZone).locations).toEqual([
			{ country: "KE", regions: ["30"] },
			{ country: "UG" },
		]);
	});

	it("drops an empty postcode list", async () => {
		const res = await saveZone([{ country: "PT", postcodes: [" "] }]);
		expect((res.body.zone as ShippingZone).locations).toEqual([{ country: "PT" }]);
	});

	it("refuses a range that starts after it ends", async () => {
		const res = await saveZone([{ country: "PT", postcodes: ["1999-1000"] }]);
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("PT: postcode range '1999-1000' starts after it ends");
	});

	it("refuses malformed entries with a clear message", async () => {
		for (const postcodes of [
			["10*00"],
			["1000-"],
			["-1000"],
			["a b;c"],
			["1".repeat(17)],
			"1000",
			[1000],
		]) {
			const res = await saveZone([{ country: "PT", postcodes }]);
			expect(res.status).toBe(400);
			expect(String(res.body.error)).toMatch(/postcode/);
		}
	});
});

describe("the hosted checkout form", () => {
	const form = readFileSync(
		fileURLToPath(new URL("../src/astro/components/HostedCheckoutForm.astro", import.meta.url)),
		"utf8",
	);

	it("marks the postcode optional, and required only in the countries listed", () => {
		expect(form).toContain('Postal code <small id="hc-postal-hint">(optional)</small>');
		expect(form).toContain("postcodeCountries = body.postcodes ?? [];");
		expect(form).toContain("const required = postcodeCountries.includes(country);");
		expect(form).toContain("postalInput.required = required;");
	});

	it("re-quotes when the postcode changes after rates are shown", () => {
		expect(form).toMatch(
			/postalInput\?\.addEventListener\("change", \(\) => \{\s*if \(!methStep \|\| methStep\.hidden\) return;[\s\S]*?locForm\.requestSubmit\(\);/,
		);
	});
});
