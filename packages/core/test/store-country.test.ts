/**
 * Checkout starts on the shop's own country instead of always "US".
 * The country is a setting, saved through the admin settings route.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { PluginContext, RouteContext } from "emdash";
import { adminApiRoutes } from "../src/routes/admin-api";
import { makeRouteContext } from "./helpers/route-harness";

async function settings(
	ctx: PluginContext,
	method: "GET" | "POST",
	input?: Record<string, unknown>,
) {
	const routeCtx = {
		request: new Request("http://test/admin/settings", { method }),
		input,
	} as unknown as RouteContext;
	const res = (await adminApiRoutes["admin/settings"].handler(routeCtx, ctx)) as Response;
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function source(relative: string): string {
	return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("storeCountry setting", () => {
	it("saves an ISO-2 code, upper-cased, and returns it", async () => {
		const { ctx } = makeRouteContext({});
		const saved = await settings(ctx, "POST", { storeCountry: " ke " });
		expect(saved.status).toBe(200);
		expect(await ctx.kv.get("settings:storeCountry")).toBe("KE");
		const read = await settings(ctx, "GET");
		expect(read.body.storeCountry).toBe("KE");
	});

	it("refuses a country name or an unknown code", async () => {
		const { ctx } = makeRouteContext({});
		for (const value of ["Kenya", "XX", 254]) {
			const res = await settings(ctx, "POST", { storeCountry: value });
			expect(res.status).toBe(400);
			expect((res.body.errors as Record<string, string>).storeCountry).toBeDefined();
		}
		expect((await ctx.kv.get("settings:storeCountry")) ?? null).toBeNull();
	});

	it("can be cleared again", async () => {
		const { ctx } = makeRouteContext({ "settings:storeCountry": "KE" });
		const cleared = await settings(ctx, "POST", { storeCountry: null });
		expect(cleared.status).toBe(200);
		expect((await settings(ctx, "GET")).body.storeCountry).toBeNull();
	});

	it("is unset on a new shop", async () => {
		const { ctx } = makeRouteContext({});
		expect((await settings(ctx, "GET")).body.storeCountry).toBeNull();
	});
});

describe("checkout starts on the shop's country", () => {
	const form = source("../src/astro/components/HostedCheckoutForm.astro");
	const starter = source("../../starter/src/pages/checkout.astro");

	it("HostedCheckoutForm starts on defaultCountry, and on US without one", () => {
		expect(form).toContain('id="hc-country" value={defaultCountry ?? "US"}');
		expect(form).toContain('id="hc-details-country" value={defaultCountry}');
	});

	it("the starter reads the setting and passes it to both checkout forms", () => {
		expect(starter).toContain('getPluginSetting("dashcommerce", "storeCountry")');
		expect(starter).toContain("defaultCountry={storeCountry}");
		expect(starter).toContain('id="country" value={storeCountry ?? "US"}');
		expect(starter).toContain('id="bCountry" value={storeCountry ?? "US"}');
	});
});
