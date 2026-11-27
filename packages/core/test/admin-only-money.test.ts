/**
 * Refunds and payment settings are for EmDash Admins only. Editors, and
 * calls with no signed-in user, get 403 with a plain message. Other settings
 * and order viewing are unchanged.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import {
	type NormalizedPaymentEvent,
	type PaymentProvider,
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import { adminApiRoutes } from "../src/routes/admin-api";
import sandbox from "../src/sandbox-entry";
import type { Order } from "../src/types";
import { ADMIN_USER, EDITOR_USER, makeRouteContext, ticketCart } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

const DRAFT_ID = "fedcba9876543210fedcba9876543210";
type Caller = typeof ADMIN_USER | undefined;
type RouteName = keyof typeof adminApiRoutes;

function provider(): PaymentProvider {
	const event: NormalizedPaymentEvent = {
		type: "charge.succeeded",
		orderDraftId: DRAFT_ID,
		providerId: "acme",
		providerEventId: "evt_admin_only_1",
		checkoutReference: "dc-admin-only",
		paymentReference: "pay_admin_only_1",
		amount: 150_000,
		currency: "KES",
		customer: { email: "supporter@example.com" },
		raw: {},
	};
	return {
		...createMockPaymentProvider({ id: "acme" }),
		label: "Acme Pay",
		webhookHeaders: ["acme-signature"],
		parseWebhookEvent: () => event,
		async getPaymentStatus() {
			return {
				status: "succeeded",
				paymentReference: "pay_admin_only_1",
				amount: 150_000,
				currency: "KES",
			};
		},
		async checkConnection() {
			return { ok: true, message: "Connected" };
		},
	};
}

/** A paid KES 1,500 order, through the real webhook route. */
async function paidOrder() {
	registerPaymentProvider(provider());
	const harness = makeRouteContext({
		"settings:paymentProvider": "acme",
		"settings:acmeSecretKey": "test-key",
		"settings:acmeWebhookSecret": "test-secret",
	});
	const { ctx, getCol } = harness;
	await ctx.kv.set(`draft:${DRAFT_ID}`, {
		cart: ticketCart("sess_admin_only"),
		ttlMs: 900_000,
		createdAt: new Date().toISOString(),
	});
	const request = new Request("http://test/checkout/webhook", {
		method: "POST",
		headers: { "acme-signature": "test-secret" },
		body: "{}",
	});
	const res = (await sandbox.routes["checkout/webhook"].handler(
		{ ...ctx, request } as unknown as RouteContext,
		ctx,
	)) as Response;
	expect(res.status).toBe(200);
	const order = Array.from(getCol("orders").values())[0] as Order;
	return { ...harness, order };
}

async function call(
	ctx: PluginContext,
	route: RouteName,
	user: Caller,
	opts: { method?: string; query?: string; input?: Record<string, unknown> } = {},
) {
	const routeCtx = {
		request: new Request(`http://test/${route}${opts.query ?? ""}`, {
			method: opts.method ?? "POST",
		}),
		input: opts.input,
		...(user ? { user } : {}),
	} as unknown as RouteContext;
	const handler = adminApiRoutes[route].handler as (
		r: RouteContext,
		c: PluginContext,
	) => Promise<unknown>;
	const res = (await handler(routeCtx, ctx)) as Response;
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const ADMIN_ONLY_REFUND = {
	error: { code: "ADMIN_ONLY", message: "Only an admin can issue refunds." },
};
const ADMIN_ONLY_SETTINGS = {
	error: { code: "ADMIN_ONLY", message: "Only an admin can change payment settings." },
};

describe("refunds are admin-only", () => {
	for (const [who, user] of [
		["an editor", EDITOR_USER],
		["a call with no user", undefined],
	] as const) {
		it(`refuses ${who} and moves no money`, async () => {
			const { ctx, getCol, order } = await paidOrder();
			const res = await call(ctx, "admin/orders/refund", user, {
				query: `?id=${order.id}`,
				input: { amount: 10_000, currency: "KES" },
			});
			expect(res).toEqual({ status: 403, body: ADMIN_ONLY_REFUND });
			expect(getCol("refunds").size).toBe(0);
		});
	}

	it("lets an admin refund", async () => {
		const { ctx, getCol, order } = await paidOrder();
		const res = await call(ctx, "admin/orders/refund", ADMIN_USER, {
			query: `?id=${order.id}`,
			input: { amount: 10_000, currency: "KES" },
		});
		expect(res.status).toBe(200);
		expect(getCol("refunds").size).toBe(1);
	});

	it("still shows editors the order, with the refund action marked off", async () => {
		const { ctx, order } = await paidOrder();
		const asEditor = await call(ctx, "admin/orders/item", EDITOR_USER, {
			method: "GET",
			query: `?id=${order.id}`,
		});
		expect(asEditor.status).toBe(200);
		expect((asEditor.body.order as Order).id).toBe(order.id);
		expect(asEditor.body.canRefund).toBe(false);
		const asAdmin = await call(ctx, "admin/orders/item", ADMIN_USER, {
			method: "GET",
			query: `?id=${order.id}`,
		});
		expect(asAdmin.body.canRefund).toBe(true);
	});
});

describe("payment settings are admin-only", () => {
	const paymentWrites: Array<[string, Record<string, unknown>]> = [
		["the provider choice", { paymentProvider: "acme" }],
		["a provider secret key", { acmeSecretKey: "new-key" }],
		["a provider webhook secret", { acmeWebhookSecret: "new-secret" }],
		["the Stripe secret key", { stripeSecretKey: "sk_test_new" }],
		["the Stripe publishable key", { stripePublishableKey: "pk_test_new" }],
		["the Stripe webhook secret", { stripeWebhookSecret: "whsec_new" }],
		["the checkout mode", { checkoutMode: "embedded" }],
		["a payment key alongside another setting", { storeCountry: "KE", acmeSecretKey: "x" }],
	];

	for (const [what, input] of paymentWrites) {
		it(`refuses an editor changing ${what}, and saves nothing`, async () => {
			const { ctx, kvStore } = await paidOrder();
			const before = new Map(kvStore);
			const res = await call(ctx, "admin/settings", EDITOR_USER, { input });
			expect(res).toEqual({ status: 403, body: ADMIN_ONLY_SETTINGS });
			expect(new Map(kvStore)).toEqual(before);
		});
	}

	it("refuses a call with no user", async () => {
		const { ctx } = await paidOrder();
		const res = await call(ctx, "admin/settings", undefined, {
			input: { acmeSecretKey: "new-key" },
		});
		expect(res).toEqual({ status: 403, body: ADMIN_ONLY_SETTINGS });
	});

	it("lets an admin change them", async () => {
		const { ctx, kvStore } = await paidOrder();
		const res = await call(ctx, "admin/settings", ADMIN_USER, {
			input: { acmeSecretKey: "new-key", stripePublishableKey: "pk_test_new" },
		});
		expect(res).toEqual({ status: 200, body: { ok: true } });
		expect(kvStore.get("settings:acmeSecretKey")).toBe("new-key");
	});

	it("still lets an editor change other settings", async () => {
		const { ctx, kvStore } = await paidOrder();
		const res = await call(ctx, "admin/settings", EDITOR_USER, {
			input: { storeCountry: "KE", downloadMaxUses: 3 },
		});
		expect(res).toEqual({ status: 200, body: { ok: true } });
		expect(kvStore.get("settings:storeCountry")).toBe("KE");
	});

	it("treats an untouched masked secret as no change", async () => {
		const { ctx } = await paidOrder();
		const res = await call(ctx, "admin/settings", EDITOR_USER, {
			input: { stripeSecretKey: "••••1234", storeCountry: "KE" },
		});
		expect(res.status).toBe(200);
	});

	it("tells the settings page whether the caller can manage payments", async () => {
		const { ctx } = await paidOrder();
		const asEditor = await call(ctx, "admin/settings", EDITOR_USER, { method: "GET" });
		expect(asEditor.body._canManagePayments).toBe(false);
		const asAdmin = await call(ctx, "admin/settings", ADMIN_USER, { method: "GET" });
		expect(asAdmin.body._canManagePayments).toBe(true);
	});

	it("keeps the connection checks for admins", async () => {
		const { ctx } = await paidOrder();
		const input = { providerId: "acme" };
		const asEditor = await call(ctx, "admin/payments/check-connection", EDITOR_USER, { input });
		expect(asEditor.status).toBe(403);
		const ping = await call(ctx, "admin/stripe/ping", EDITOR_USER);
		expect(ping.status).toBe(403);
		const asAdmin = await call(ctx, "admin/payments/check-connection", ADMIN_USER, { input });
		expect(asAdmin).toEqual({ status: 200, body: { ok: true, message: "Connected" } });
	});
});
