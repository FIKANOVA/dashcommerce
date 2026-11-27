/**
 * Shipping zones can name regions within a country, so a Kenyan shop can
 * charge one rate for Nairobi City and another for the rest of Kenya.
 * Hosted checkout asks for the region only when a zone names regions in
 * the chosen country, and the cart's zone match uses it.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RouteContext } from "emdash";
import sandbox from "../src/sandbox-entry";
import type { CartState, ShippingMethod, ShippingZone } from "../src/types";
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

/** Kenya-wide delivery at KSh 500, Nairobi City (KE-30) at KSh 200. */
const kenyaZones = [
	// Same order as the Nairobi zone and stored first: the zone that names
	// the region must still win.
	zone("zone_ke", "Kenya", [{ country: "KE" }]),
	zone("zone_nbo", "Nairobi", [{ country: "KE", regions: ["30"] }]),
];
const kenyaMethods = [
	flatRate("ship_ke", "zone_ke", "Upcountry delivery", 50000),
	flatRate("ship_nbo", "zone_nbo", "Nairobi delivery", 20000),
];

function routeContext(ctx: unknown, path: string, sessionId: string, input: unknown, method = "POST") {
	return {
		...(ctx as object),
		request: new Request(`http://test/${path}`, {
			method,
			headers: { Cookie: `dashcommerce_sid=${sessionId}` },
		}),
		input,
	} as unknown as RouteContext;
}

function shop(zones = kenyaZones, methods = kenyaMethods) {
	const { ctx, getCol } = makeRouteContext({});
	for (const z of zones) getCol("shipping_zones").set(z.id, z.data);
	for (const m of methods) getCol("shipping_methods").set(m.id, m.data);
	const call = async (path: string, sessionId: string, input: unknown = {}, method = "POST") => {
		const res = (await sandbox.routes[path].handler(
			routeContext(ctx, path, sessionId, input, method),
			ctx,
		)) as Response;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	};
	return { ctx, call };
}

async function newCart(ctx: { kv: { set(k: string, v: unknown): Promise<void> } }) {
	const sessionId = `sess_${Math.random()}`;
	await ctx.kv.set(`cart:${sessionId}`, { ...ticketCart(sessionId), shippingAddress: undefined });
	return sessionId;
}

/** Post the ship-to location, then list the rates the cart is offered. */
async function ratesFor(location: Record<string, unknown>) {
	const { ctx, call } = shop();
	const sessionId = await newCart(ctx);
	const loc = await call("cart/shipping-location", sessionId, location);
	expect(loc.status).toBe(200);
	const rates = await call("cart/shipping-methods", sessionId, {}, "GET");
	const options = rates.body.options as Array<{ methodId: string; amount: { amount: number } }>;
	return { cart: loc.body.cart as CartState, options, call, sessionId };
}

describe("rates by region through the cart routes", () => {
	it("gives a Nairobi address the Nairobi zone's rate", async () => {
		const { cart, options } = await ratesFor({ country: "KE", region: "30" });
		expect(cart.shippingAddress?.region).toBe("30");
		expect(options.map((o) => [o.methodId, o.amount.amount])).toEqual([["ship_nbo", 20000]]);
	});

	it("gives an upcountry address the country-wide rate", async () => {
		const { options } = await ratesFor({ country: "KE", region: "31" });
		expect(options.map((o) => [o.methodId, o.amount.amount])).toEqual([["ship_ke", 50000]]);
	});

	it("treats Elsewhere (an empty region) as the rest of the country", async () => {
		const { options } = await ratesFor({ country: "KE", region: "" });
		expect(options.map((o) => o.methodId)).toEqual(["ship_ke"]);
	});

	it("gives a cart without a region the country-wide rate", async () => {
		const { cart, options } = await ratesFor({ country: "KE" });
		expect(cart.shippingAddress?.region).toBe("");
		expect(options.map((o) => [o.methodId, o.amount.amount])).toEqual([["ship_ke", 50000]]);
	});

	it("lets a Nairobi cart choose the Nairobi rate, and not an upcountry cart", async () => {
		const nairobi = await ratesFor({ country: "KE", region: "30" });
		const chosen = await nairobi.call("cart/shipping-method", nairobi.sessionId, {
			methodId: "ship_nbo",
		});
		expect(chosen.status).toBe(200);
		expect((chosen.body.cart as CartState).shippingMethod?.amount).toEqual(kes(20000));

		const upcountry = await ratesFor({ country: "KE", region: "31" });
		const refused = await upcountry.call("cart/shipping-method", upcountry.sessionId, {
			methodId: "ship_nbo",
		});
		expect(refused.status).toBe(409);
	});

	it("drops the region when the country changes, and keeps it when not", async () => {
		const { call, sessionId } = await ratesFor({ country: "KE", region: "30" });
		const same = await call("cart/shipping-location", sessionId, { country: "KE", postalCode: "00100" });
		expect((same.body.cart as CartState).shippingAddress?.region).toBe("30");
		const moved = await call("cart/shipping-location", sessionId, { country: "UG" });
		expect((moved.body.cart as CartState).shippingAddress?.region).toBe("");
	});

	it("refuses a region that is not short text", async () => {
		const { ctx, call } = shop();
		const sessionId = await newCart(ctx);
		const res = await call("cart/shipping-location", sessionId, { country: "KE", region: 30 });
		expect(res.status).toBe(400);
		expect(String(res.body.error)).toMatch(/region/);
	});
});

describe("regions checked against the zones", () => {
	const address = (region: string) => ({
		firstName: "Wanjiru",
		lastName: "Kamau",
		line1: "Ngong Road",
		city: "Nairobi",
		region,
		postalCode: "",
		country: "KE",
	});

	it("takes KE-30 as 30 on every route that sets the ship-to region", async () => {
		const located = await ratesFor({ country: "KE", region: "KE-30" });
		expect(located.cart.shippingAddress?.region).toBe("30");
		expect(located.options.map((o) => o.methodId)).toEqual(["ship_nbo"]);

		const { ctx, call } = shop();
		const viaContact = await newCart(ctx);
		const contact = await call("cart/contact", viaContact, {
			email: "shopper@example.com",
			shippingAddress: address("ke-30"),
		});
		expect((contact.body.cart as CartState).shippingAddress?.region).toBe("30");

		const viaAddress = await newCart(ctx);
		const set = await call("cart/shipping-address", viaAddress, { address: address("KE-30") });
		expect((set.body.cart as CartState).shippingAddress?.region).toBe("30");
		const rates = await call("cart/shipping-methods", viaAddress, {}, "GET");
		expect((rates.body.options as Array<{ methodId: string }>).map((o) => o.methodId)).toEqual([
			"ship_nbo",
		]);
	});

	it("turns a county name typed on the address into its code", async () => {
		const { ctx, call } = shop();
		const sessionId = await newCart(ctx);
		const res = await call("cart/shipping-address", sessionId, { address: address("Nairobi") });
		expect((res.body.cart as CartState).shippingAddress?.region).toBe("30");
	});

	it("keeps a real county the zones don't name, priced as elsewhere", async () => {
		const { cart, options } = await ratesFor({ country: "KE", region: "KE-28" });
		expect(cart.shippingAddress?.region).toBe("28");
		expect(options.map((o) => o.methodId)).toEqual(["ship_ke"]);
	});

	it("stores a region nobody knows as no region instead of refusing it", async () => {
		const { cart, options } = await ratesFor({ country: "KE", region: "Atlantis" });
		expect(cart.shippingAddress?.region).toBe("");
		expect(options.map((o) => o.methodId)).toEqual(["ship_ke"]);
	});

	it("leaves the region alone in a country whose zones name none", async () => {
		const { cart } = await ratesFor({ country: "UG", region: "Kampala" });
		expect(cart.shippingAddress?.region).toBe("Kampala");
	});
});

describe("cart/shipping-regions", () => {
	it("lists the regions the zones name, with their names", async () => {
		const { ctx, call } = shop([
			...kenyaZones,
			zone("zone_coast", "Coast", [{ country: "KE", regions: ["28", "14"] }]),
			zone("zone_tz", "Tanzania", [{ country: "TZ", regions: ["02"] }]),
		]);
		const res = await call("cart/shipping-regions", await newCart(ctx), {}, "GET");
		expect(res.status).toBe(200);
		expect(res.body.countries).toEqual({
			KE: {
				label: "County",
				regions: [
					{ code: "14", name: "Kilifi" },
					{ code: "28", name: "Mombasa" },
					{ code: "30", name: "Nairobi City" },
				],
			},
			// No names for Tanzania: the code is shown as it is.
			TZ: { label: "Region", regions: [{ code: "02", name: "02" }] },
		});
	});

	it("lists nothing when no zone names regions", async () => {
		const { ctx, call } = shop([zone("zone_ke", "Kenya", [{ country: "KE" }])]);
		const res = await call("cart/shipping-regions", await newCart(ctx), {}, "GET");
		expect(res.body.countries).toEqual({});
	});
});

describe("the hosted checkout form", () => {
	const form = readFileSync(
		fileURLToPath(new URL("../src/astro/components/HostedCheckoutForm.astro", import.meta.url)),
		"utf8",
	);

	it("has a labelled region select, hidden until a country has regions", () => {
		expect(form).toMatch(
			/<label class="hc-label" id="hc-region-field" hidden>\s*<span id="hc-region-label">Region<\/span>\s*<select id="hc-region"/,
		);
		expect(form).toContain("cart/shipping-regions");
		expect(form).toContain('new Option("Elsewhere", ELSEWHERE)');
	});

	it("sends the region with the location and with the customer's address", () => {
		expect(form).toContain("...(region === undefined ? {} : { region })");
		expect(form).toContain('region: digitalOnly ? "" : (chosenRegion() ?? ""),');
	});
});
