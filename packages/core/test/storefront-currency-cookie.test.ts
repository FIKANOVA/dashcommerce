/**
 * Cart responses tell server-rendered pages the cart's currency through the
 * `dashcommerce_currency` cookie, so product pages can show the same
 * currency as the cart. The session cookie still comes back alongside it.
 */

import { describe, expect, it } from "bun:test";
import { STOREFRONT_CURRENCY_COOKIE, storefrontCurrency } from "../src/astro/currency";
import { cartRoutes } from "../src/routes/cart";

function stubCtx(settings: Record<string, unknown> = {}) {
	const store = new Map<string, unknown>(Object.entries(settings));
	return {
		kv: {
			async get(k: string) {
				return store.get(k) ?? null;
			},
			async set(k: string, v: unknown) {
				store.set(k, v);
			},
			async delete(k: string) {
				return store.delete(k);
			},
			async list() {
				return [];
			},
		},
		storage: {},
		log: { debug() {}, info() {}, warn() {}, error() {} },
	} as unknown as import("emdash").PluginContext;
}

function routeCtx(pathname: string, method: string, cookie?: string, input: unknown = {}) {
	return {
		input,
		request: new Request(`http://test${pathname}`, {
			method,
			headers: cookie ? { cookie } : {},
		}),
	} as unknown as import("emdash").RouteContext;
}

describe("currency cookie on cart responses", () => {
	it("sets the session cookie and the cart's currency on a new shopper's first request", async () => {
		const ctx = stubCtx({ "settings:defaultCurrency": "KES" });
		const res = (await cartRoutes.cart.handler(routeCtx("/cart", "GET"), ctx)) as Response;
		expect(res.status).toBe(200);
		const cookies = res.headers.getSetCookie();
		expect(cookies).toHaveLength(2);
		expect(cookies[0]).toStartWith("dashcommerce_sid=");
		expect(cookies[1]).toBe(
			`${STOREFRONT_CURRENCY_COOKIE}=KES; Path=/; SameSite=Lax; Max-Age=2592000`,
		);
	});

	it("follows a currency switch, and only sets the currency for a returning shopper", async () => {
		const ctx = stubCtx({
			"settings:defaultCurrency": "USD",
			"settings:enabledCurrencies": ["USD", "KES"],
		});
		const sid = "dashcommerce_sid=shopper1";
		await cartRoutes.cart.handler(routeCtx("/cart", "GET", sid), ctx);
		const res = (await cartRoutes["cart/currency"].handler(
			routeCtx("/cart/currency", "POST", sid, { currency: "kes" }),
			ctx,
		)) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.getSetCookie()).toEqual([
			`${STOREFRONT_CURRENCY_COOKIE}=KES; Path=/; SameSite=Lax; Max-Age=2592000`,
		]);
		expect(((await res.json()) as { cart: { currency: string } }).cart.currency).toBe("KES");
	});
});

describe("storefrontCurrency", () => {
	const jar = (value?: string) => ({
		get: (name: string) =>
			name === STOREFRONT_CURRENCY_COOKIE && value !== undefined ? { value } : undefined,
	});

	it("reads the cart's currency for pages", () => {
		expect(storefrontCurrency(jar("KES"))).toBe("KES");
		expect(storefrontCurrency(jar("kes"))).toBe("KES");
	});

	it("returns nothing before the first cart response, or for a value that isn't a currency code", () => {
		expect(storefrontCurrency(jar())).toBeUndefined();
		expect(storefrontCurrency(jar("<script>"))).toBeUndefined();
		expect(storefrontCurrency(jar("KESX"))).toBeUndefined();
	});
});
