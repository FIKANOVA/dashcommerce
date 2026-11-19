/**
 * FIK-59 slice 2: "set up" state (SPEC D1) and the admin setup routes.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import {
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import { adminApiRoutes } from "../src/routes/admin-api";
import { setupRoutes } from "../src/routes/setup";
import { makeRouteContext } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

type Json = Record<string, unknown>;

async function route(
	ctx: PluginContext,
	name: "admin/setup/status" | "admin/setup/check" | "admin/settings",
	method: "GET" | "POST" = "GET",
	input?: Json,
): Promise<{ status: number; body: Json }> {
	const routeCtx = {
		request: new Request(`http://test/${name}`, { method }),
		input,
	} as unknown as RouteContext;
	const handler =
		name === "admin/settings"
			? adminApiRoutes["admin/settings"].handler
			: setupRoutes[name].handler;
	const res = (await handler(routeCtx, ctx)) as Response;
	return { status: res.status, body: (await res.json()) as Json };
}

function registerAcme(check: { ok: boolean; detail?: string } | null = { ok: true }) {
	registerPaymentProvider({
		...createMockPaymentProvider({
			id: "acme",
			onPageCheckout: true,
			supportedCurrencies: ["KES"],
			...(check ? { checkConnectionResult: check } : {}),
		}),
		label: "Acme Pay",
		description: "Card and mobile money",
		credentialFields: { secretKey: { prefixes: ["ak_"] }, webhookSecret: { prefixes: ["aw_"] } },
	});
}

describe("set-up state", () => {
	it("a fresh install is not set up", async () => {
		const { ctx } = makeRouteContext({});
		const { body } = await route(ctx, "admin/setup/status");
		expect(body.setUp).toBe(false);
		expect(body.activeProviderId).toBe("stripe");
	});

	it("an existing Stripe install with both keys is set up, with no check needed", async () => {
		const { ctx } = makeRouteContext({
			"settings:stripeSecretKey": "sk_test_1234567890abcdef",
			"settings:stripeWebhookSecret": "whsec_1234567890abcdef",
		});
		const { body } = await route(ctx, "admin/setup/status");
		expect(body.setUp).toBe(true);
	});

	it("a provider with a connection check is set up only after a passing check", async () => {
		registerAcme();
		const { ctx } = makeRouteContext({ "settings:defaultCurrency": "KES" });
		await route(ctx, "admin/settings", "POST", {
			paymentProvider: "acme",
			acmeSecretKey: "ak_1",
			acmeWebhookSecret: "aw_1",
		});
		expect((await route(ctx, "admin/setup/status")).body.setUp).toBe(false);

		const check = await route(ctx, "admin/setup/check", "POST");
		expect(check.body.ok).toBe(true);
		expect((await route(ctx, "admin/setup/status")).body.setUp).toBe(true);
	});

	it("a failed check leaves it not set up and reports the provider's message", async () => {
		registerAcme({ ok: false, detail: "Invalid key" });
		const { ctx } = makeRouteContext({
			"settings:paymentProvider": "acme",
			"settings:acmeSecretKey": "ak_1",
			"settings:acmeWebhookSecret": "aw_1",
		});
		const check = await route(ctx, "admin/setup/check", "POST");
		expect(check.body).toMatchObject({ ok: false, detail: "Invalid key" });
		expect((await route(ctx, "admin/setup/status")).body.setUp).toBe(false);
	});

	it("changing the keys after a passing check asks for a fresh check", async () => {
		registerAcme();
		const { ctx } = makeRouteContext({});
		await route(ctx, "admin/settings", "POST", {
			paymentProvider: "acme",
			acmeSecretKey: "ak_1",
			acmeWebhookSecret: "aw_1",
		});
		await route(ctx, "admin/setup/check", "POST");
		expect((await route(ctx, "admin/setup/status")).body.setUp).toBe(true);

		await new Promise((r) => setTimeout(r, 5));
		await route(ctx, "admin/settings", "POST", { acmeSecretKey: "ak_2" });
		expect((await route(ctx, "admin/setup/status")).body.setUp).toBe(false);
	});

	it("a provider without a connection check is set up once both keys are saved", async () => {
		registerAcme(null);
		const { ctx } = makeRouteContext({});
		await route(ctx, "admin/settings", "POST", { paymentProvider: "acme", acmeSecretKey: "ak_1" });
		expect((await route(ctx, "admin/setup/status")).body.setUp).toBe(false);
		await route(ctx, "admin/settings", "POST", { acmeWebhookSecret: "aw_1" });
		expect((await route(ctx, "admin/setup/status")).body.setUp).toBe(true);
	});
});

describe("setup status payload", () => {
	it("lists providers with what the setup screen needs, and the webhook URL", async () => {
		registerAcme();
		const { ctx } = makeRouteContext({
			"settings:paymentProvider": "acme",
			"settings:defaultCurrency": "USD",
			"settings:acmeSecretKey": "ak_secret_value_9876",
		});
		const { body } = await route(ctx, "admin/setup/status");
		const providers = body.providers as Json[];
		expect(providers.map((p) => p.id)).toEqual(["stripe", "acme"]);
		expect(providers.find((p) => p.id === "acme")).toMatchObject({
			label: "Acme Pay",
			description: "Card and mobile money",
			checkoutStyles: ["hosted", "on_page"],
			supportsDefaultCurrency: false,
			canCheckConnection: true,
			secrets: {
				secretKey: { isSet: true, hint: "••••9876" },
				webhookSecret: { isSet: false, hint: null },
			},
		});
		expect(providers.find((p) => p.id === "stripe")).toMatchObject({
			checkoutStyles: ["hosted", "on_page"],
			supportsDefaultCurrency: true,
		});
		expect(body.webhookUrl).toBe(
			"https://shop.example/_emdash/api/plugins/dashcommerce/checkout/webhook?provider=acme",
		);
		expect(JSON.stringify(body)).not.toContain("ak_secret_value");
	});

	it("checks the provider named in the request, so the screen can test before switching", async () => {
		registerAcme({ ok: false, detail: "Invalid key" });
		const { ctx } = makeRouteContext({
			"settings:acmeSecretKey": "ak_1",
			"settings:acmeWebhookSecret": "aw_1",
		});
		const check = await route(ctx, "admin/setup/check", "POST", { providerId: "acme" });
		expect(check.body).toMatchObject({ ok: false, providerId: "acme" });
	});

	it("refuses to check a provider with no secret key saved", async () => {
		registerAcme();
		const { ctx } = makeRouteContext({ "settings:paymentProvider": "acme" });
		const check = await route(ctx, "admin/setup/check", "POST");
		expect(check.status).toBe(400);
	});
});
