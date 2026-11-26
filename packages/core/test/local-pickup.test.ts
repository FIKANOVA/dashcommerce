/**
 * Local pickup carries where and when to collect, and a pickup order
 * checks out without a delivery address. Driven through core's real
 * admin, cart, checkout and webhook routes.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import {
	createMockPaymentProvider,
	type InitCheckoutInput,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import sandbox from "../src/sandbox-entry";
import type { Order, ShippingMethod } from "../src/types";
import { deliverWebhook, makeRouteContext } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

const settings = {
	"settings:paymentProvider": "mock",
	"settings:checkoutMode": "hosted",
	"settings:mockSecretKey": "k",
	"settings:mockWebhookSecret": "test-secret",
	"settings:storeCurrency": "KES",
	"settings:currencies": ["KES"],
};

type Routes = Record<string, { handler: (r: RouteContext, c: PluginContext) => unknown }>;
const routes = sandbox.routes as unknown as Routes;

async function call(
	ctx: PluginContext,
	route: string,
	input?: unknown,
	opts: { method?: string; sessionId?: string; query?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const request = new Request(`http://test/${route}${opts.query ?? ""}`, {
		method: opts.method ?? (input === undefined ? "GET" : "POST"),
		headers: {
			"Content-Type": "application/json",
			...(opts.sessionId ? { Cookie: `dashcommerce_sid=${opts.sessionId}` } : {}),
		},
		...(input === undefined ? {} : { body: JSON.stringify(input) }),
	});
	const routeCtx = { ...ctx, request, input } as unknown as RouteContext;
	const handler = routes[route]?.handler;
	if (!handler) throw new Error(`No route ${route}`);
	const res = (await handler(routeCtx, ctx)) as Response;
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A shop with one physical product and a Kenya zone. */
async function shop() {
	const h = makeRouteContext(settings);
	(h.ctx as unknown as { content: unknown }).content = {
		async get(collection: string, id: string) {
			if (collection !== "products" || id !== "prod_mug") return null;
			return {
				id: "prod_mug",
				status: "published",
				data: {
					title: "Club mug",
					type: "simple",
					prices: { KES: { amount: 120000 } },
					manage_stock: false,
				},
			};
		},
	};
	await h.ctx.storage.shipping_zones.put("zone_ke", {
		id: "zone_ke",
		name: "Kenya",
		locations: [{ country: "KE" }],
		order: 0,
		createdAt: "2026-11-01T00:00:00.000Z",
		updatedAt: "2026-11-01T00:00:00.000Z",
	});
	return h;
}

async function addMethod(ctx: PluginContext, body: Record<string, unknown>) {
	return call(ctx, "admin/shipping/methods", { zoneId: "zone_ke", enabled: true, ...body });
}

const pickupDetails = {
	location: "Shop 4, Example Plaza, Nairobi",
	instructions: "Ask at the front desk.",
	hours: "Mon–Sat, 9am–5pm",
};

/** Put a one-mug cart on the session, set the country and choose `methodId`. */
async function cartWithMethod(ctx: PluginContext, sessionId: string, methodId: string) {
	const kes = (amount: number) => ({ amount, currency: "KES" });
	await ctx.kv.set(`cart:${sessionId}`, {
		sessionId,
		currency: "KES",
		items: [
			{
				lineId: "line_1",
				productId: "prod_mug",
				quantity: 1,
				title: "Club mug",
				isDigital: false,
				unitPrice: kes(120000),
				lineSubtotal: kes(120000),
			},
		],
		coupons: [],
		taxLines: [],
		subtotal: kes(120000),
		discountTotal: kes(0),
		shippingTotal: kes(0),
		taxTotal: kes(0),
		total: kes(120000),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
	expect(
		(await call(ctx, "cart/shipping-location", { country: "KE" }, { sessionId })).status,
	).toBe(200);
	const options = await call(ctx, "cart/shipping-methods", undefined, { sessionId });
	const chosen = await call(ctx, "cart/shipping-method", { methodId }, { sessionId });
	expect(chosen.status).toBe(200);
	// The customer gives their email and name only: no street or town.
	const contact = await call(
		ctx,
		"cart/contact",
		{
			email: "shopper@example.com",
			billingAddress: {
				firstName: "Test",
				lastName: "Shopper",
				line1: "",
				city: "",
				region: "",
				postalCode: "",
				country: "KE",
			},
		},
		{ sessionId },
	);
	expect(contact.status).toBe(200);
	return { options: options.body.options as Array<Record<string, unknown>> };
}

describe("pickup details on the shipping method", () => {
	it("saves and returns them, as plain text", async () => {
		const { ctx } = await shop();
		const res = await addMethod(ctx, {
			title: "Store pickup",
			type: "local_pickup",
			config: {
				type: "local_pickup",
				pickup: {
					...pickupDetails,
					instructions: "  <b>Ask</b> at the front desk.\u0007  ",
					hours: "",
				},
			},
		});
		expect(res.status).toBe(201);
		const saved = (res.body.method as ShippingMethod).config;
		expect(saved).toEqual({
			type: "local_pickup",
			pickup: { location: pickupDetails.location, instructions: "Ask at the front desk." },
		});

		const listed = await call(ctx, "admin/shipping");
		const methods = listed.body.methods as ShippingMethod[];
		expect(methods[0]?.config).toEqual(saved);
	});

	it("refuses text over the limit or that isn't text", async () => {
		const { ctx } = await shop();
		const tooLong = await addMethod(ctx, {
			title: "Store pickup",
			type: "local_pickup",
			config: { type: "local_pickup", pickup: { location: "x".repeat(301) } },
		});
		expect(tooLong.status).toBe(400);
		expect(String(tooLong.body.error)).toMatch(/location/);

		const notText = await addMethod(ctx, {
			title: "Store pickup",
			type: "local_pickup",
			config: { type: "local_pickup", pickup: { hours: 9 } },
		});
		expect(notText.status).toBe(400);
	});

	it("keeps a pickup method without details working as before", async () => {
		const { ctx } = await shop();
		const res = await addMethod(ctx, {
			title: "Store pickup",
			type: "local_pickup",
			config: { type: "local_pickup" },
		});
		expect(res.status).toBe(201);
		expect((res.body.method as ShippingMethod).config).toEqual({ type: "local_pickup" });
	});
});

describe("checking out", () => {
	it("a pickup cart pays without a delivery address, and the order says pickup", async () => {
		let sent: InitCheckoutInput | undefined;
		const mock = createMockPaymentProvider();
		registerPaymentProvider(
			{
				...mock,
				async initCheckout(c, input, creds) {
					sent = input;
					return mock.initCheckout(c, input, creds);
				},
			},
			{ override: true },
		);
		const { ctx, getCol } = await shop();
		const method = await addMethod(ctx, {
			title: "Store pickup",
			type: "local_pickup",
			config: { type: "local_pickup", pickup: pickupDetails },
		});
		const methodId = (method.body.method as ShippingMethod).id;

		const sessionId = "sess_pickup";
		const { options } = await cartWithMethod(ctx, sessionId, methodId);
		expect(options[0]?.pickup).toEqual(pickupDetails);

		const session = await call(ctx, "checkout/create-session", {}, { sessionId });
		expect(session.status).toBe(200);
		// Nothing is delivered, so the payment page isn't asked for an address.
		expect(sent?.shippingAddressCollection).toBeUndefined();

		const res = await deliverWebhook(
			ctx,
			JSON.stringify({
				id: "evt_pickup_1",
				type: "charge.succeeded",
				orderDraftId: session.body.orderDraftId,
				paymentReference: "pay_pickup_1",
				amount: 120000,
				currency: "KES",
			}),
			{ "x-mock-signature": "signed" },
		);
		expect(res.status).toBe(200);
		const orders = [...getCol("orders").values()] as unknown as Order[];
		expect(orders).toHaveLength(1);
		expect(orders[0]?.pickup).toEqual(pickupDetails);
		expect(orders[0]?.shippingMethodLabel).toBe("Store pickup");

		const thanks = await call(ctx, "orders/by-draft", undefined, {
			query: `?id=${session.body.orderDraftId}`,
		});
		expect((thanks.body.order as Record<string, unknown>).pickup).toEqual(pickupDetails);
	});

	it("a delivery cart still needs a delivery address", async () => {
		registerPaymentProvider(createMockPaymentProvider(), { override: true });
		const { ctx } = await shop();
		const method = await addMethod(ctx, {
			title: "Courier",
			type: "flat_rate",
			config: { type: "flat_rate", amount: { amount: 30000, currency: "KES" } },
		});
		const sessionId = "sess_delivery";
		await cartWithMethod(ctx, sessionId, (method.body.method as ShippingMethod).id);

		const session = await call(ctx, "checkout/create-session", {}, { sessionId });
		expect(session.status).toBe(409);
		expect(session.body.code).toBe("customer_details_required");
		expect(session.body.missing).toEqual(["address"]);
	});
});
