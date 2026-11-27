/**
 * A replaced checkout attempt paid after the checkout was already paid
 * becomes an on-hold duplicate order. Like any paid order it takes stock;
 * cancelling it, or refunding it with "Restock items", must put that stock
 * back.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import {
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import { adminApiRoutes } from "../src/routes/admin-api";
import sandbox from "../src/sandbox-entry";
import type { CartState, InventoryLedgerEntry, Order, Refund } from "../src/types";
import { ADMIN_USER, deliverWebhook, makeRouteContext, ticketCart } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

const kes = (amount: number) => ({ amount, currency: "KES" });

/** One club mug (stock 5) with free courier delivery in Kenya. */
function mugCart(sessionId: string): CartState {
	const line = {
		lineId: "line_1",
		productId: "prod_mug",
		quantity: 1,
		title: "Club mug",
		isDigital: false,
		unitPrice: kes(80000),
		lineSubtotal: kes(80000),
	};
	return {
		...ticketCart(sessionId),
		items: [line],
		shippingMethod: { id: "ship_free", label: "Courier", amount: kes(0) },
		subtotal: kes(80000),
		total: kes(80000),
	} as unknown as CartState;
}

async function startMugCheckout(ctx: PluginContext, sessionId: string): Promise<string> {
	await ctx.kv.set(`cart:${sessionId}`, mugCart(sessionId));
	const routeCtx = {
		...ctx,
		request: new Request("http://test/checkout/create-session", {
			method: "POST",
			headers: { Cookie: `dashcommerce_sid=${sessionId}` },
		}),
		input: {},
	} as unknown as RouteContext;
	const res = (await sandbox.routes["checkout/create-session"].handler(routeCtx, ctx)) as Response;
	const body = (await res.json()) as { orderDraftId?: string; error?: string };
	if (!body.orderDraftId) throw new Error(`create-session failed: ${body.error ?? res.status}`);
	return body.orderDraftId;
}

function paid(orderDraftId: string, n: number): string {
	return JSON.stringify({
		id: `evt_${n}`,
		type: "charge.succeeded",
		orderDraftId,
		paymentReference: `pay_${n}`,
		amount: 80000,
		currency: "KES",
		email: "supporter@example.com",
	});
}

/** Two attempts of one checkout, both paid: returns the on-hold duplicate. */
async function duplicateOrder() {
	registerPaymentProvider(createMockPaymentProvider());
	const h = makeRouteContext({
		"settings:paymentProvider": "mock",
		"settings:checkoutMode": "hosted",
		"settings:mockSecretKey": "mock-secret-key",
		"settings:mockWebhookSecret": "test-secret",
	});
	h.getCol("shipping_zones").set("zone_ke", {
		id: "zone_ke",
		name: "Kenya",
		locations: [{ country: "KE" }],
		order: 0,
	});
	h.getCol("shipping_methods").set("ship_free", {
		id: "ship_free",
		zoneId: "zone_ke",
		type: "flat_rate",
		title: "Courier",
		enabled: true,
		config: { type: "flat_rate", amount: kes(0) },
		order: 0,
	});
	const first = await startMugCheckout(h.ctx, "sess_dup");
	const second = await startMugCheckout(h.ctx, "sess_dup");
	const headers = { "x-mock-signature": "signed" };
	expect((await deliverWebhook(h.ctx, paid(second, 2), headers)).status).toBe(200);
	expect((await deliverWebhook(h.ctx, paid(first, 1), headers)).status).toBe(200);

	const orders = [...h.getCol("orders").entries()].map(([id, o]) => ({ ...(o as unknown as Order), id }));
	const duplicate = orders.find((o) => o.paymentReference === "pay_1");
	expect(duplicate?.status).toBe("on-hold");
	// Both orders took a mug.
	expect(h.products.get("prod_mug")?.data.stock_quantity).toBe(3);
	return { ...h, duplicate: duplicate as Order };
}

async function admin(ctx: PluginContext, route: keyof typeof adminApiRoutes, id: string, input: unknown) {
	const routeCtx = {
		request: new Request(`http://test/${route}?id=${id}`, { method: "POST" }),
		input,
		user: ADMIN_USER,
	} as unknown as RouteContext;
	const res = (await adminApiRoutes[route].handler(routeCtx, ctx)) as Response;
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("stock on an on-hold duplicate order", () => {
	it("is put back when the order is cancelled, once", async () => {
		const { ctx, duplicate, products, getCol } = await duplicateOrder();
		const res = await admin(ctx, "admin/orders/status", duplicate.id, { status: "cancelled" });
		expect(res.status).toBe(200);
		expect(products.get("prod_mug")?.data.stock_quantity).toBe(4);
		const ledger = [...getCol("inventory_ledger").values()] as unknown as InventoryLedgerEntry[];
		expect(ledger.filter((e) => e.reason === "order_cancelled")).toEqual([
			expect.objectContaining({ orderId: duplicate.id, productId: "prod_mug", delta: 1 }),
		]);

		// Saving the same status again puts nothing more back.
		await admin(ctx, "admin/orders/status", duplicate.id, { status: "cancelled" });
		expect(products.get("prod_mug")?.data.stock_quantity).toBe(4);
	});

	it("is put back by a full refund with Restock items", async () => {
		const { ctx, duplicate, products, getCol } = await duplicateOrder();
		const res = await admin(ctx, "admin/orders/refund", duplicate.id, {
			amount: 80000,
			currency: "KES",
			restock: true,
		});
		expect(res.status).toBe(200);
		expect(products.get("prod_mug")?.data.stock_quantity).toBe(4);
		const refund = [...getCol("refunds").values()][0] as unknown as Refund;
		expect(refund.restocked).toBe(true);
		expect(refund.lineItemRefunds).toEqual([
			expect.objectContaining({ quantity: 1, amount: kes(80000) }),
		]);
	});

	it("refuses Restock items on a partial refund that doesn't say which items", async () => {
		const { ctx, duplicate, products, getCol } = await duplicateOrder();
		const res = await admin(ctx, "admin/orders/refund", duplicate.id, {
			amount: 40000,
			currency: "KES",
			restock: true,
		});
		expect(res.status).toBe(400);
		expect(String(res.body.error)).toMatch(/restock/i);
		expect(getCol("refunds").size).toBe(0);
		expect(products.get("prod_mug")?.data.stock_quantity).toBe(3);
	});
});

describe("restock is clamped to the stock the order still holds", () => {
	function mugLine(getCol: (name: string) => Map<string, Record<string, unknown>>, orderId: string) {
		const entry = [...getCol("order_items").entries()].find(([, it]) => it.orderId === orderId);
		if (!entry) throw new Error("no order item");
		return entry[0];
	}

	it("a refund with Restock after a cancel puts nothing back twice", async () => {
		const { ctx, duplicate, products, getCol } = await duplicateOrder();
		await admin(ctx, "admin/orders/status", duplicate.id, { status: "cancelled" });
		expect(products.get("prod_mug")?.data.stock_quantity).toBe(4);

		const res = await admin(ctx, "admin/orders/refund", duplicate.id, {
			amount: 80000,
			currency: "KES",
			restock: true,
			lineItemRefunds: [
				{ orderItemId: mugLine(getCol, duplicate.id), quantity: 1, amount: 80000, currency: "KES" },
			],
		});
		expect(res.status).toBe(200);
		expect(products.get("prod_mug")?.data.stock_quantity).toBe(4);
		const refund = [...getCol("refunds").values()][0] as unknown as Refund;
		expect(refund.lineItemRefunds?.[0]?.restockedQuantity).toBe(0);
	});

	it("two partial refunds with Restock put back only what the order took", async () => {
		const { ctx, duplicate, products, getCol } = await duplicateOrder();
		const line = mugLine(getCol, duplicate.id);
		for (const n of [1, 2]) {
			const res = await admin(ctx, "admin/orders/refund", duplicate.id, {
				amount: 40000,
				currency: "KES",
				restock: true,
				lineItemRefunds: [{ orderItemId: line, quantity: 1, amount: 40000, currency: "KES" }],
				reason: `part ${n}`,
			});
			expect(res.status).toBe(200);
		}
		expect(products.get("prod_mug")?.data.stock_quantity).toBe(4);
	});

	it("asking back more units than the line took restocks only those taken", async () => {
		const { ctx, duplicate, products, getCol } = await duplicateOrder();
		const res = await admin(ctx, "admin/orders/refund", duplicate.id, {
			amount: 80000,
			currency: "KES",
			restock: true,
			lineItemRefunds: [
				{ orderItemId: mugLine(getCol, duplicate.id), quantity: 5, amount: 80000, currency: "KES" },
			],
		});
		expect(res.status).toBe(200);
		expect(products.get("prod_mug")?.data.stock_quantity).toBe(4);
	});

	it("an untracked line restocks nothing", async () => {
		const { ctx, duplicate, products, getCol } = await duplicateOrder();
		// As for an untracked or digital product: the order took no stock.
		getCol("inventory_ledger").clear();
		const res = await admin(ctx, "admin/orders/refund", duplicate.id, {
			amount: 80000,
			currency: "KES",
			restock: true,
			lineItemRefunds: [
				{ orderItemId: mugLine(getCol, duplicate.id), quantity: 1, amount: 80000, currency: "KES" },
			],
		});
		expect(res.status).toBe(200);
		expect(products.get("prod_mug")?.data.stock_quantity).toBe(3);
	});
});
