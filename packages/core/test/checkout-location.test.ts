/**
 * Checkout location: delivery areas on zones, their precedence, the area
 * on the cart routes, what `cart/shipping-regions` tells hosted checkout,
 * the admin Areas field and "Check an address", outward-code postcodes,
 * the new subdivision names, and the hosted form's markup.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PluginContext, RouteContext } from "emdash";
import { REGION_TABLE, regionCode, regionName } from "../src/data/regions";
import sandbox from "../src/sandbox-entry";
import { areaMatches, parseAreaList } from "../src/shipping/areas";
import { matchZone, pickZone } from "../src/shipping/calculate";
import { parsePostcodeEntry, postcodeMatches } from "../src/shipping/postcodes";
import type { Address, CartState, ShippingMethod, ShippingZone } from "../src/types";
import { ADMIN_USER, EDITOR_USER, makeRouteContext } from "./helpers/route-harness";

type Routes = Record<string, { handler: (r: RouteContext, c: PluginContext) => unknown }>;
const routes = sandbox.routes as unknown as Routes;

function zone(id: string, locations: ShippingZone["locations"], order = 0): ShippingZone {
	return {
		id,
		name: id,
		locations,
		order,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
	};
}

const kenya = [
	zone("ke", [{ country: "KE" }]),
	zone("nbo", [{ country: "KE", regions: ["30"] }]),
	zone("cbd", [{ country: "KE", postcodes: ["00100"] }]),
	zone("west", [{ country: "KE", regions: ["30"], areas: ["Westlands", "Kilimani"] }]),
];
const methods: ShippingMethod[] = [
	{
		id: "r_ke",
		zoneId: "ke",
		type: "flat_rate",
		title: "Kenya delivery",
		enabled: true,
		config: { type: "flat_rate", amount: { amount: 50_000, currency: "KES" } },
		order: 0,
	},
	{
		id: "r_usd",
		zoneId: "ke",
		type: "flat_rate",
		title: "Courier",
		enabled: true,
		config: { type: "flat_rate", amount: { amount: 400, currency: "USD" } },
		order: 0,
	},
	{
		id: "r_west",
		zoneId: "west",
		type: "flat_rate",
		title: "Westlands rider",
		enabled: true,
		config: { type: "flat_rate", amount: { amount: 20_000, currency: "KES" } },
		order: 0,
	},
];

function address(city: string, region = "30", postalCode = ""): Address {
	return { firstName: "", lastName: "", line1: "", city, region, postalCode, country: "KE" };
}

function shop(zones: ShippingZone[] = kenya, kv: Record<string, unknown> = {}) {
	const h = makeRouteContext(kv);
	for (const z of zones) h.getCol("shipping_zones").set(z.id, z as unknown as Record<string, unknown>);
	for (const m of methods) h.getCol("shipping_methods").set(m.id, m as unknown as Record<string, unknown>);
	const call = async (
		path: string,
		sessionId: string,
		input?: unknown,
		opts: { method?: string; user?: unknown } = {},
	) => {
		const request = new Request(`http://test/${path}`, {
			method: opts.method ?? (input === undefined ? "GET" : "POST"),
			headers: { Cookie: `dashcommerce_sid=${sessionId}` },
		});
		const routeCtx = {
			...(h.ctx as object),
			request,
			input,
			...(opts.user ? { user: opts.user } : {}),
		} as unknown as RouteContext;
		const res = (await routes[path].handler(routeCtx, h.ctx)) as Response;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	};
	return { ...h, call };
}

describe("areas on zone locations", () => {
	it("match without case, accents or extra spaces, and not unlisted areas", () => {
		const areas = ["Westlands", "Málaga Road", "Dubai Marina"];
		for (const city of ["westlands", "  WESTLANDS ", "malaga road", "MALAGA   ROAD", "dubai\tmarina"]) {
			expect(areaMatches(city, areas)).toBe(true);
		}
		for (const city of ["", "West lands", "Westland", "Karen", undefined]) {
			expect(areaMatches(city, areas)).toBe(false);
		}
	});

	it("puts area before postcode before region before country at the same order", () => {
		expect(matchZone(address("Westlands", "30", "00100"), kenya)).toMatchObject({
			zone: { id: "west" },
			reason: "area",
		});
		expect(matchZone(address("Karen", "30", "00100"), kenya)).toMatchObject({
			zone: { id: "cbd" },
			reason: "postcode",
		});
		expect(matchZone(address("Karen", "30"), kenya)).toMatchObject({ zone: { id: "nbo" }, reason: "region" });
		expect(matchZone(address("Westlands", "28"), kenya)).toMatchObject({
			zone: { id: "ke" },
			reason: "country",
		});
		// Whatever order they are stored in.
		expect(pickZone(address("Westlands"), [...kenya].reverse())?.id).toBe("west");
	});

	it("still lets a lower order win over an area match", () => {
		const ordered = [{ ...kenya[3], order: 5 } as ShippingZone, kenya[0] as ShippingZone];
		expect(pickZone(address("Westlands"), ordered)?.id).toBe("ke");
	});

	it("needs the region too when a location lists both", () => {
		expect(pickZone(address("Westlands", "28"), [kenya[3] as ShippingZone])).toBeNull();
	});

	it("leaves zones without areas as they were", () => {
		const plain = kenya.slice(0, 3);
		expect(pickZone(address("Westlands", "30"), plain)?.id).toBe("nbo");
		expect(pickZone(address("", "30", "00100"), plain)?.id).toBe("cbd");
	});
});

describe("the area on cart routes", () => {
	const newCart = async (s: ReturnType<typeof shop>) => {
		const sessionId = `sess_${Math.random()}`;
		await s.call("cart/currency", sessionId, { currency: "KES" });
		return sessionId;
	};
	const full = {
		firstName: "Wanjiru",
		lastName: "Kamau",
		line1: "Ring Road",
		city: "Nairobi",
		region: "30",
		postalCode: "",
		country: "KE",
	};
	const bad = ["<b>Westlands</b>", "West\u0000lands", "Westlands\nKilimani", "x".repeat(81), 42];

	it("cart/shipping-location stores it as the city and quotes the area rate", async () => {
		const s = shop();
		const sessionId = await newCart(s);
		const res = await s.call("cart/shipping-location", sessionId, {
			country: "KE",
			region: "30",
			area: "  Westlands  ",
		});
		expect((res.body.cart as CartState).shippingAddress?.city).toBe("Westlands");
		const rates = await s.call("cart/shipping-methods", sessionId);
		expect((rates.body.options as Array<{ methodId: string }>).map((o) => o.methodId)).toEqual(["r_west"]);
	});

	it("refuses markup, control characters, over-length or non-text areas on all three routes", async () => {
		const s = shop();
		const sessionId = await newCart(s);
		for (const area of bad) {
			const loc = await s.call("cart/shipping-location", sessionId, { country: "KE", area });
			const addr = await s.call("cart/shipping-address", sessionId, { address: full, area });
			const contact = await s.call("cart/contact", sessionId, {
				email: "a@example.com",
				shippingAddress: full,
				area,
			});
			for (const res of [loc, addr, contact]) {
				expect(res.status).toBe(400);
				expect(String(res.body.error)).toMatch(/^area /);
			}
		}
	});

	it("cart/shipping-address and cart/contact store the area as the city", async () => {
		const s = shop();
		const sessionId = await newCart(s);
		const addr = await s.call("cart/shipping-address", sessionId, { address: full, area: "Kilimani" });
		expect((addr.body.cart as CartState).shippingAddress?.city).toBe("Kilimani");
		const contact = await s.call("cart/contact", sessionId, {
			email: "a@example.com",
			shippingAddress: full,
			area: "Westlands",
		});
		expect((contact.body.cart as CartState).shippingAddress?.city).toBe("Westlands");
		// Without an area, the address's own city is kept.
		const plain = await s.call("cart/contact", sessionId, { email: "a@example.com", shippingAddress: full });
		expect((plain.body.cart as CartState).shippingAddress?.city).toBe("Nairobi");
	});
});

describe("cart/shipping-regions for hosted checkout", () => {
	it("lists the countries shipped to and the areas by country and region", async () => {
		const s = shop([
			...kenya,
			zone("ng", [{ country: "NG", areas: ["Lekki"] }]),
			zone("ug", [{ country: "UG" }]),
		]);
		const res = await s.call("cart/shipping-regions", "sess_x");
		expect(res.body.shipsTo).toEqual(["KE", "NG", "UG"]);
		expect(res.body.areas).toEqual({
			KE: { country: [], regions: { "30": ["Kilimani", "Westlands"] } },
			NG: { country: ["Lekki"], regions: {} },
		});
	});

	it("lists every country when no zone lists one", async () => {
		const res = await shop([]).call("cart/shipping-regions", "sess_x");
		const shipsTo = res.body.shipsTo as string[];
		expect(shipsTo).toContain("KE");
		expect(shipsTo).toContain("JP");
		expect(shipsTo.length).toBeGreaterThan(150);
		expect(res.body.areas).toEqual({});
	});
});

describe("areas in the admin zone routes", () => {
	const save = (locations: unknown) =>
		shop([]).call("admin/shipping/zones", "admin", { name: "Nairobi", locations });

	it("tidies, de-duplicates and stores areas", async () => {
		const res = await save([
			{ country: "KE", regions: ["30"], areas: [" Westlands ", "westlands", "Kilimani", "  ", "CBD  Area"] },
		]);
		expect(res.status).toBe(201);
		expect((res.body.zone as ShippingZone).locations).toEqual([
			{ country: "KE", regions: ["30"], areas: ["Westlands", "Kilimani", "CBD Area"] },
		]);
	});

	it("refuses bad areas with a clear message", async () => {
		for (const areas of [["<script>"], ["a\u0007b"], ["x".repeat(81)], "Westlands", [1]]) {
			const res = await save([{ country: "KE", areas }]);
			expect(res.status).toBe(400);
			expect(String(res.body.error)).toMatch(/^KE: (area|areas) /);
		}
		const many = Array.from({ length: 201 }, (_, i) => `Area ${i}`);
		const res = await save([{ country: "KE", areas: many }]);
		expect(res.status).toBe(400);
		expect(res.body.error).toBe("KE: list at most 200 areas per country");
	});

	it("parses the list the same way the route does", () => {
		expect(parseAreaList(["Lekki", "LEKKI", "Ikeja"])).toEqual({ ok: true, value: ["Lekki", "Ikeja"] });
	});
});

describe("Check an address in Admin → Shipping", () => {
	it("names the zone, the reason and the options per currency, using checkout's matching", async () => {
		const s = shop(kenya, { "settings:enabledCurrencies": ["KES", "USD"] });
		const res = await s.call(
			"admin/shipping/check",
			"admin",
			{ country: "KE", region: "Nairobi", area: "westlands", postalCode: "" },
			{ user: ADMIN_USER },
		);
		expect(res.status).toBe(200);
		expect(res.body.zone).toEqual({ id: "west", name: "west" });
		expect(res.body.reason).toBe("area");
		expect(res.body.currencies).toEqual([
			{
				currency: "KES",
				options: [{ methodId: "r_west", label: "Westlands rider", amount: { amount: 20_000, currency: "KES" } }],
			},
			{ currency: "USD", options: [] },
		]);
		const rest = await s.call("admin/shipping/check", "admin", { country: "KE", region: "28" }, { user: ADMIN_USER });
		expect(rest.body.reason).toBe("country");
		const nowhere = await s.call("admin/shipping/check", "admin", { country: "FR" }, { user: ADMIN_USER });
		expect(nowhere.body.zone).toBeNull();
	});

	it("is admin-only, refuses bad input, and writes nothing", async () => {
		const s = shop(kenya);
		const before = JSON.stringify([...s.getCol("shipping_zones").entries()]);
		const editor = await s.call("admin/shipping/check", "x", { country: "KE" }, { user: EDITOR_USER });
		expect(editor.status).toBe(403);
		const anon = await s.call("admin/shipping/check", "x", { country: "KE" });
		expect(anon.status).toBe(403);
		for (const input of [{ country: "Kenya" }, { country: "KE", area: "<b>" }, { country: "KE", postalCode: "1;2" }]) {
			expect((await s.call("admin/shipping/check", "x", input, { user: ADMIN_USER })).status).toBe(400);
		}
		expect(JSON.stringify([...s.getCol("shipping_zones").entries()])).toBe(before);
		expect(s.kvStore.size).toBe(0);
	});
});

describe("outward-code postcode entries", () => {
	it("stores `SW1 ` with its space and matches that outward code only", () => {
		expect(parsePostcodeEntry("sw1 ")).toEqual({ ok: true, value: "SW1 " });
		expect(parsePostcodeEntry(" EC1A  ")).toEqual({ ok: true, value: "EC1A " });
		// Digits with a stray space stay a plain prefix, as before.
		expect(parsePostcodeEntry(" 2600 ")).toEqual({ ok: true, value: "2600" });
		expect(postcodeMatches("SW1 1AA", ["SW1 "])).toBe(true);
		expect(postcodeMatches("SW10 1AA", ["SW1 "])).toBe(false);
		expect(postcodeMatches("SW10 1AA", ["SW1"])).toBe(true);
		expect(postcodeMatches("ec1a1bb", ["EC1A "])).toBe(true);
		expect(postcodeMatches("", ["EC1A "])).toBe(false);
	});

	it("is saved through the admin route", async () => {
		const res = await shop([]).call("admin/shipping/zones", "admin", {
			name: "Central London",
			locations: [{ country: "GB", postcodes: ["SW1 ", "EC1A ", "W1"] }],
		});
		expect((res.body.zone as ShippingZone).locations).toEqual([
			{ country: "GB", postcodes: ["SW1 ", "EC1A ", "W1"] },
		]);
	});
});

describe("subdivision names", () => {
	const expected: Record<string, [number, string, string]> = {
		NG: [37, "LA", "Lagos"],
		CA: [13, "ON", "Ontario"],
		AU: [8, "NSW", "New South Wales"],
		IN: [36, "MH", "Maharashtra"],
		BR: [27, "SP", "São Paulo"],
		ZA: [9, "GP", "Gauteng"],
		AE: [7, "DU", "Dubai"],
		JP: [47, "13", "Tokyo"],
		KE: [47, "30", "Nairobi City"],
		US: [51, "CA", "California"],
	};

	for (const [country, [count, code, name]] of Object.entries(expected)) {
		it(`${country} has ${count} named regions, including ${code} ${name}`, () => {
			expect(REGION_TABLE[country]?.regions.length).toBe(count);
			expect(regionName(country, code)).toBe(name);
			expect(regionCode(country, name)).toBe(code);
			expect(regionCode(country, `${country}-${code}`)).toBe(code);
		});
	}

	it("turns names into codes without accents or case, for the state pickers", () => {
		expect(regionCode("BR", "sao paulo")).toBe("SP");
		expect(regionCode("JP", "OKINAWA")).toBe("47");
		expect(regionCode("JP", "hokkaido")).toBe("01");
		expect(regionCode("ZA", "KwaZulu-Natal")).toBe("KZN");
		expect(regionCode("IN", "Telangana")).toBe("TS");
		expect(regionCode("NG", "Federal Capital Territory")).toBe("FC");
	});

	it("maps India's replaced ISO codes to the current ones", () => {
		expect(regionCode("IN", "UT")).toBe("UK");
		expect(regionCode("IN", "IN-CT")).toBe("CG");
		expect(regionCode("IN", "tg")).toBe("TS");
		expect(regionCode("IN", "OR")).toBe("OD");
	});

	it("keeps codes unique within each country", () => {
		for (const [country, table] of Object.entries(REGION_TABLE)) {
			const codes = table.regions.map((r) => r.code);
			expect(new Set(codes).size, country).toBe(codes.length);
		}
	});
});

describe("the hosted checkout form", () => {
	const form = readFileSync(
		fileURLToPath(new URL("../src/astro/components/HostedCheckoutForm.astro", import.meta.url)),
		"utf8",
	);

	it("has a labelled country dropdown by name that still sends ISO-2", () => {
		expect(form).toMatch(/<span>Country<\/span>\s*<select required id="hc-country-select" autocomplete="shipping country">/);
		expect(form).toContain('new Intl.DisplayNames([...navigator.languages, "en"], { type: "region" })');
		expect(form).toContain("showCountries(body.shipsTo ?? []);");
		expect(form).toContain('countryInput.value = countrySelect?.value ?? "";');
	});

	it("has a labelled Area dropdown with Somewhere else, sent as `area`", () => {
		expect(form).toMatch(
			/<label class="hc-label" id="hc-area-field" hidden>\s*<span>Area<\/span>\s*<select id="hc-area" autocomplete="shipping address-level2">/,
		);
		expect(form).toContain('new Option("Somewhere else", ELSEWHERE)');
		expect(form).toContain("body: JSON.stringify({ country, postalCode, area,");
		expect(form).toContain("city.value = area;");
	});

	it("gives address inputs their autofill tokens", () => {
		for (const token of [
			'autocomplete="shipping country"',
			'autocomplete="shipping address-level1"',
			'autocomplete="shipping address-level2"',
			'autocomplete="shipping postal-code"',
			'autocomplete="shipping address-line1"',
			'autocomplete="email"',
			'autocomplete="given-name"',
			'autocomplete="family-name"',
			'autocomplete="tel"',
		]) {
			expect(form).toContain(token);
		}
	});

	it("puts merchant text in with textContent and formats zero-decimal currencies", () => {
		expect(form).toContain("name.textContent = opt.label;");
		expect(form).not.toContain("label.innerHTML");
		expect(form).toContain("return formatMinor(m, navigator.language);");
		expect(form).not.toContain("m.amount / 100");
	});
});
