/**
 * Counter sales (in-person checkout) through core's real routes, with the
 * mock provider standing in for the gateway. Staff add products, stock is
 * held, the provider is asked for payment, and the order comes through the
 * same path as an online one, marked as a counter sale with the seller.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { PluginContext, RouteContext } from "emdash";
import {
	type PaymentStatusResult,
	type StartInPersonPaymentInput,
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import { adminApiRoutes } from "../src/routes/admin-api";
import sandbox from "../src/sandbox-entry";
import type { Order, StockLock } from "../src/types";
import { ADMIN_USER, EDITOR_USER, deliverWebhook, makeRouteContext } from "./helpers/route-harness";

afterEach(() => resetPaymentProviders());

type Caller = { id: string; email: string; role: number } | undefined;

/** A Kenyan shop whose provider takes phone prompts and card terminals. */
function shop(opts: { status?: () => PaymentStatusResult } = {}) {
	const started: StartInPersonPaymentInput[] = [];
	let live: PaymentStatusResult = { status: "pending" };
	registerPaymentProvider(
		createMockPaymentProvider({
			paymentStatus: opts.status ?? (() => live),
			inPerson: {
				methods: ["phone", "terminal"],
				terminals: [{ id: "TERM_front", name: "Front till" }],
				onStart: (input) => started.push(input),
			},
		}),
	);
	const harness = makeRouteContext({
		"settings:paymentProvider": "mock",
		"settings:mockSecretKey": "test-key",
		"settings:mockWebhookSecret": "test-secret",
		"settings:defaultCurrency": "KES",
		"settings:storeCountry": "KE",
	});
	return {
		...harness,
		started,
		setLive(next: PaymentStatusResult) {
			live = next;
		},
	};
}

async function call(
	ctx: PluginContext,
	route: string,
	user: Caller,
	opts: { method?: string; query?: string; input?: unknown } = {},
) {
	const routeCtx = {
		...ctx,
		request: new Request(`http://test/${route}${opts.query ?? ""}`, {
			method: opts.method ?? "POST",
		}),
		input: opts.input,
		...(user ? { user } : {}),
	} as unknown as RouteContext;
	const res = (await sandbox.routes[route].handler(routeCtx, ctx)) as Response;
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const PHONE_SALE = {
	lines: [{ productId: "prod_mug", quantity: 2 }],
	method: { type: "phone", phone: "+254 712 345 678" },
};

async function startPhoneSale(ctx: PluginContext, user: Caller = EDITOR_USER) {
	const res = await call(ctx, "admin/counter/sale", user, { input: PHONE_SALE });
	expect(res.status).toBe(200);
	return res.body as { orderDraftId: string; status: string; total: { amount: number } };
}

function status(ctx: PluginContext, draft: string, user: Caller) {
	return call(ctx, "admin/counter/status", user, { method: "GET", query: `?draft=${draft}` });
}

function stock(products: Map<string, { data: Record<string, unknown> }>) {
	return products.get("prod_mug")?.data.stock_quantity;
}

describe("counter sale: phone", () => {
	it("an Editor starts a phone sale: stock is held and the provider gets the phone", async () => {
		const { ctx, kvStore, started } = shop();
		const sale = await startPhoneSale(ctx);

		expect(sale.status).toBe("pending");
		expect(sale.total.amount).toBe(160_000);
		const lock = kvStore.get(`lock:${sale.orderDraftId}`) as StockLock;
		expect(lock.entries).toEqual([{ productId: "prod_mug", quantity: 2 }]);
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({
			orderDraftId: sale.orderDraftId,
			amount: 160_000,
			currency: "KES",
			method: { type: "phone", phone: "+254712345678" },
			// No customer email given: the seller's own address stands in.
			customer: { email: EDITOR_USER.email, phone: "+254712345678" },
		});
	});

	it("reports pending, then paid with the order number once the webhook arrives", async () => {
		const { ctx, kvStore, getCol, products, setLive } = shop();
		const sale = await startPhoneSale(ctx);

		expect((await status(ctx, sale.orderDraftId, EDITOR_USER)).body.status).toBe("pending");

		// The customer approves; Paystack-style, the webhook is checked live.
		setLive({ status: "succeeded", amount: 160_000, currency: "KES" });
		const webhook = await deliverWebhook(
			ctx,
			JSON.stringify({
				id: "evt_counter_1",
				type: "charge.succeeded",
				orderDraftId: sale.orderDraftId,
				paymentReference: `mock_counter_${sale.orderDraftId}`,
				amount: 160_000,
				currency: "KES",
				email: EDITOR_USER.email,
			}),
			{ "x-mock-signature": "test-secret" },
		);
		expect(await webhook.text()).toContain('"received":true');

		const paid = await status(ctx, sale.orderDraftId, EDITOR_USER);
		const order = Array.from(getCol("orders").values())[0] as Order;
		expect(paid.body).toMatchObject({ status: "paid", orderNumber: order.orderNumber });
		expect(order.channel).toBe("in_person");
		expect(order.soldBy).toBe(EDITOR_USER.id);
		expect(order.total.amount).toBe(160_000);
		expect(stock(products)).toBe(3);
		expect(kvStore.has(`lock:${sale.orderDraftId}`)).toBe(false);
	});

	it("creates the order from the status check when the provider confirms first", async () => {
		const { ctx, getCol, products, setLive } = shop();
		const sale = await startPhoneSale(ctx);
		setLive({ status: "succeeded", amount: 160_000, currency: "KES" });

		const paid = await status(ctx, sale.orderDraftId, EDITOR_USER);
		expect(paid.body.status).toBe("paid");
		expect(getCol("orders").size).toBe(1);
		expect(stock(products)).toBe(3);

		// Asking again, or a late webhook, creates nothing more.
		await status(ctx, sale.orderDraftId, EDITOR_USER);
		expect(getCol("orders").size).toBe(1);
	});

	it("a declined payment releases the stock and says why", async () => {
		const { ctx, kvStore, getCol, setLive } = shop();
		const sale = await startPhoneSale(ctx);
		setLive({ status: "failed", reason: "Request cancelled by user" });

		const failed = await status(ctx, sale.orderDraftId, EDITOR_USER);
		expect(failed.body).toMatchObject({
			status: "failed",
			failure: "declined",
			reason: "Request cancelled by user",
		});
		expect(kvStore.has(`lock:${sale.orderDraftId}`)).toBe(false);
		expect(getCol("orders").size).toBe(0);
	});

	it("a payment left waiting times out and releases the stock", async () => {
		const { ctx, kvStore } = shop();
		const sale = await startPhoneSale(ctx);
		const key = `counter:${sale.orderDraftId}`;
		const record = kvStore.get(key) as { startedAt: string };
		kvStore.set(key, { ...record, startedAt: new Date(Date.now() - 6 * 60_000).toISOString() });

		const failed = await status(ctx, sale.orderDraftId, EDITOR_USER);
		expect(failed.body).toMatchObject({ status: "failed", failure: "timed_out" });
		expect(kvStore.has(`lock:${sale.orderDraftId}`)).toBe(false);
	});

	it("Retry replaces the earlier hold instead of holding the stock twice", async () => {
		const { ctx, kvStore } = shop();
		const first = await startPhoneSale(ctx);
		const second = await startPhoneSale(ctx);
		expect(kvStore.has(`lock:${first.orderDraftId}`)).toBe(false);
		expect(kvStore.has(`lock:${second.orderDraftId}`)).toBe(true);
	});

	it("refuses more than the stock on hand", async () => {
		const { ctx, kvStore } = shop();
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, {
			input: { ...PHONE_SALE, lines: [{ productId: "prod_mug", quantity: 6 }] },
		});
		expect(res.status).toBe(409);
		expect([...kvStore.keys()].some((k) => k.startsWith("lock:"))).toBe(false);
	});

	it("refuses a bare number with no leading 0 or country code", async () => {
		const { ctx, started } = shop();
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, {
			input: { ...PHONE_SALE, method: { type: "phone", phone: "712345678" } },
		});
		expect(res.status).toBe(400);
		expect(started).toHaveLength(0);
		const local = await call(ctx, "admin/counter/sale", EDITOR_USER, {
			input: { ...PHONE_SALE, method: { type: "phone", phone: "0712 345 678" } },
		});
		expect(local.status).toBe(200);
	});

	it("refuses a phone number that isn't one", async () => {
		const { ctx, started } = shop();
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, {
			input: { ...PHONE_SALE, method: { type: "phone", phone: "call me" } },
		});
		expect(res.status).toBe(400);
		expect(started).toHaveLength(0);
	});
});

describe("counter sale: late payments and races", () => {
	function backdate(kvStore: Map<string, unknown>, draft: string) {
		const key = `counter:${draft}`;
		const record = kvStore.get(key) as { startedAt: string };
		kvStore.set(key, { ...record, startedAt: new Date(Date.now() - 6 * 60_000).toISOString() });
	}

	async function terminalSale(ctx: PluginContext) {
		const res = await call(ctx, "admin/counter/sale", EDITOR_USER, {
			input: {
				lines: [{ productId: "prod_mug", quantity: 1 }],
				method: { type: "terminal", terminalId: "TERM_front" },
			},
		});
		expect(res.status).toBe(200);
		return String(res.body.orderDraftId);
	}

	it("a terminal tap after the time-out still becomes the order", async () => {
		const { ctx, kvStore, getCol, products, setLive } = shop();
		const draft = await terminalSale(ctx);
		backdate(kvStore, draft);
		expect((await status(ctx, draft, EDITOR_USER)).body).toMatchObject({
			status: "failed",
			failure: "timed_out",
		});

		// The customer taps their card at 5:30.
		setLive({ status: "succeeded", amount: 80_000, currency: "KES" });
		const late = await status(ctx, draft, EDITOR_USER);
		const order = Array.from(getCol("orders").values())[0] as Order;
		expect(late.body).toMatchObject({ status: "paid", orderNumber: order.orderNumber });
		expect(order.channel).toBe("in_person");
		expect(stock(products)).toBe(4);
	});

	it("Retry refuses to charge again when the earlier attempt was paid late", async () => {
		const { ctx, kvStore, getCol, started, setLive } = shop();
		const draft = await terminalSale(ctx);
		backdate(kvStore, draft);
		await status(ctx, draft, EDITOR_USER);
		setLive({ status: "succeeded", amount: 80_000, currency: "KES" });

		const retry = await call(ctx, "admin/counter/sale", EDITOR_USER, {
			input: {
				lines: [{ productId: "prod_mug", quantity: 1 }],
				method: { type: "terminal", terminalId: "TERM_front" },
				retryOf: draft,
			},
		});
		expect(retry.status).toBe(409);
		expect(retry.body.sale).toMatchObject({ status: "paid" });
		expect(started).toHaveLength(1);
		expect(getCol("orders").size).toBe(1);
	});

	it("the webhook and the status check confirming at once create one order", async () => {
		const { ctx, kvStore, getCol, products, setLive } = shop();
		const sale = await startPhoneSale(ctx);
		setLive({ status: "succeeded", amount: 160_000, currency: "KES" });

		const [webhook] = await Promise.all([
			deliverWebhook(
				ctx,
				JSON.stringify({
					id: "evt_counter_race",
					type: "charge.succeeded",
					orderDraftId: sale.orderDraftId,
					paymentReference: `mock_counter_${sale.orderDraftId}`,
					amount: 160_000,
					currency: "KES",
					email: EDITOR_USER.email,
				}),
				{ "x-mock-signature": "test-secret" },
			),
			status(ctx, sale.orderDraftId, EDITOR_USER),
		]);
		expect(webhook.status).toBe(200);

		const paid = await status(ctx, sale.orderDraftId, EDITOR_USER);
		expect(paid.body.status).toBe("paid");
		expect(getCol("orders").size).toBe(1);
		// The loser stopped before any side effect.
		const customers = Array.from(getCol("customers").values()) as Array<{ ordersCount: number }>;
		expect(customers.map((c) => c.ordersCount)).toEqual([1]);
		expect(kvStore.get("state:orderNumberCounter")).toBe(1001);
		expect(stock(products)).toBe(3);
	});
});

describe("counter sale: terminal", () => {
	it("pushes the amount to the chosen terminal", async () => {
		const { ctx, started } = shop();
		const res = await call(ctx, "admin/counter/sale", ADMIN_USER, {
			input: {
				lines: [{ productId: "prod_ticket", quantity: 1 }],
				method: { type: "terminal", terminalId: "TERM_front" },
				customerEmail: "Fan@Example.com",
			},
		});
		expect(res.status).toBe(200);
		expect(started[0]).toMatchObject({
			amount: 150_000,
			currency: "KES",
			method: { type: "terminal", terminalId: "TERM_front" },
			customer: { email: "fan@example.com" },
		});
	});

	it("refuses a terminal that isn't on the account", async () => {
		const { ctx, started } = shop();
		const res = await call(ctx, "admin/counter/sale", ADMIN_USER, {
			input: { ...PHONE_SALE, method: { type: "terminal", terminalId: "TERM_other" } },
		});
		expect(res.status).toBe(400);
		expect(started).toHaveLength(0);
	});

	it("setup lists the methods and terminals", async () => {
		const { ctx } = shop();
		const res = await call(ctx, "admin/counter/setup", EDITOR_USER, { method: "GET" });
		expect(res.body).toMatchObject({
			available: true,
			currency: "KES",
			methods: ["phone", "terminal"],
			terminals: [{ id: "TERM_front", name: "Front till" }],
		});
	});
});

describe("counter sale: who may sell", () => {
	const SUBSCRIBER = { ...EDITOR_USER, id: "user_sub", role: 10 };
	const CONTRIBUTOR = { ...EDITOR_USER, id: "user_contrib", role: 20 };

	for (const [who, user] of [
		["a Subscriber", SUBSCRIBER],
		["a Contributor", CONTRIBUTOR],
		["a call with no user", undefined],
	] as const) {
		it(`refuses ${who}`, async () => {
			const { ctx, kvStore, started } = shop();
			for (const route of ["admin/counter/sale", "admin/counter/setup", "admin/counter/products"]) {
				const res = await call(ctx, route, user, { input: PHONE_SALE });
				expect(res.status).toBe(403);
			}
			const res = await status(ctx, "0".repeat(32), user);
			expect(res.status).toBe(403);
			expect(started).toHaveLength(0);
			expect([...kvStore.keys()].some((k) => k.startsWith("lock:"))).toBe(false);
		});
	}

	it("refunds stay admin-only for a counter sale", async () => {
		const { ctx, getCol, setLive } = shop();
		const sale = await startPhoneSale(ctx);
		setLive({ status: "succeeded", amount: 160_000, currency: "KES" });
		await status(ctx, sale.orderDraftId, EDITOR_USER);
		const order = Array.from(getCol("orders").entries())[0];
		const routeCtx = {
			request: new Request(`http://test/admin/orders/refund?id=${order?.[0]}`, { method: "POST" }),
			input: { amount: 80_000, currency: "KES" },
			user: EDITOR_USER,
		} as unknown as RouteContext;
		const res = (await adminApiRoutes["admin/orders/refund"].handler(routeCtx, ctx)) as Response;
		expect(res.status).toBe(403);
	});
});

describe("orders list: channel filter", () => {
	it("filters counter sales from online orders", async () => {
		const { ctx, getCol, setLive } = shop();
		const sale = await startPhoneSale(ctx);
		setLive({ status: "succeeded", amount: 160_000, currency: "KES" });
		await status(ctx, sale.orderDraftId, EDITOR_USER);
		const counterId = Array.from(getCol("orders").keys())[0];
		getCol("orders").set("online_order", {
			...(getCol("orders").get(counterId ?? "") as Record<string, unknown>),
			channel: undefined,
			soldBy: undefined,
			orderNumber: "online-1",
			stripePaymentIntentId: "pi_online",
		});

		const list = async (channel: string) => {
			const routeCtx = {
				request: new Request(`http://test/admin/orders?channel=${channel}`, { method: "GET" }),
				user: ADMIN_USER,
			} as unknown as RouteContext;
			const res = (await adminApiRoutes["admin/orders"].handler(routeCtx, ctx)) as Response;
			const body = (await res.json()) as { items: Array<{ id: string }> };
			return body.items.map((o) => o.id);
		};
		expect(await list("in_person")).toEqual([counterId]);
		expect(await list("online")).toEqual(["online_order"]);
	});
});
