import { beforeEach, describe, expect, it } from "bun:test";
import {
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import { reconcilePaymentAttempt } from "../src/payment-provider/reconcile";
import { draftKey } from "../src/routes/checkout";
import { webhookRoutes } from "../src/routes/webhook";
import type { CartState, Order } from "../src/types";

function makeMockContext(initialKv?: Record<string, unknown>) {
	const kvStore = new Map<string, unknown>(Object.entries(initialKv ?? {}));
	const collections = new Map<string, Map<string, unknown>>();

	function getCol(name: string): Map<string, unknown> {
		let col = collections.get(name);
		if (!col) {
			col = new Map();
			collections.set(name, col);
		}
		return col;
	}

	const storage = new Proxy(
		{},
		{
			get(_target, prop: string) {
				const col = getCol(prop);
				return {
					async get(id: string) {
						return col.get(id) ?? null;
					},
					async put(id: string, data: unknown) {
						col.set(id, data);
					},
					async putMany(items: Array<{ id: string; data: unknown }>) {
						for (const item of items) {
							col.set(item.id, item.data);
						}
					},
					async delete(id: string) {
						col.delete(id);
					},
					async query(opts?: { where?: Record<string, unknown>; limit?: number }) {
						const all = Array.from(col.entries()).map(([id, data]) => ({
							id,
							data,
						}));
						const where = opts?.where;
						if (!where) return { items: all, hasMore: false };
						const filtered = all.filter((item) => {
							const d = item.data as Record<string, unknown>;
							for (const [k, v] of Object.entries(where)) {
								if (d[k] !== v) return false;
							}
							return true;
						});
						return { items: filtered, hasMore: false };
					},
					async count() {
						return col.size;
					},
				};
			},
		},
	);

	const productsMap = new Map<
		string,
		{ id: string; status: string; data: Record<string, unknown> }
	>();
	productsMap.set("prod_1", {
		id: "prod_1",
		status: "published",
		data: {
			title: "Club Jersey",
			type: "simple",
			prices: {
				USD: { amount: 5000 },
				KES: { amount: 500000 },
			},
			manage_stock: true,
			stock_quantity: 100,
			stock_status: "instock",
			is_digital: true,
		},
	});

	const content = {
		async get(collection: string, id: string) {
			if (collection === "products") {
				return productsMap.get(id) ?? null;
			}
			return null;
		},
		async update(collection: string, id: string, patch: Record<string, unknown>) {
			if (collection === "products") {
				const p = productsMap.get(id);
				if (p) {
					p.data = { ...p.data, ...patch };
				}
			}
		},
	};

	const ctx = {
		kv: {
			async get<T>(key: string): Promise<T | null> {
				return (kvStore.get(key) as T | undefined) ?? null;
			},
			async set(key: string, value: unknown) {
				kvStore.set(key, value);
			},
			async delete(key: string) {
				return kvStore.delete(key);
			},
			async list(prefix?: string) {
				return Array.from(kvStore.keys()).filter((k) => (prefix ? k.startsWith(prefix) : true));
			},
		},
		storage,
		content,
		log: {
			debug() {},
			info() {},
			warn() {},
			error() {},
		},
		url(path: string) {
			return `https://store.example.com${path}`;
		},
	} as unknown as import("emdash").PluginContext;

	return { ctx, kvStore, getCol, productsMap };
}

const defaultAddress = {
	firstName: "Amina",
	lastName: "Mohamed",
	line1: "Ngong Road",
	city: "Nairobi",
	country: "KE",
};

describe("Asynchronous Payment Reconciliation & Lifecycle", () => {
	beforeEach(() => {
		resetPaymentProviders();
	});

	it("returns pending status while async payment is unresolved", async () => {
		const asyncProvider = createMockPaymentProvider({
			id: "async-pending-mock",
			asyncPendingCheckout: true,
			// getPaymentStatus defaults to pending
		});
		registerPaymentProvider(asyncProvider);

		const { ctx } = makeMockContext({
			"settings:paymentProvider": "async-pending-mock",
		});

		const orderDraftId = "draft_unresolved_1";
		const cart: CartState = {
			sessionId: "sess_unresolved",
			currency: "USD",
			customerEmail: "buyer@example.com",
			billingAddress: defaultAddress,
			shippingAddress: defaultAddress,
			items: [
				{
					lineId: "line_1",
					productId: "prod_1",
					isDigital: true,
					quantity: 1,
					unitPrice: { amount: 5000, currency: "USD" },
					lineSubtotal: { amount: 5000, currency: "USD" },
					title: "Club Jersey",
				},
			],
			coupons: [],
			taxLines: [],
			subtotal: { amount: 5000, currency: "USD" },
			discountTotal: { amount: 0, currency: "USD" },
			shippingTotal: { amount: 0, currency: "USD" },
			taxTotal: { amount: 0, currency: "USD" },
			total: { amount: 5000, currency: "USD" },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		await ctx.kv.set(draftKey(orderDraftId), {
			cart,
			ttlMs: 60000,
			createdAt: new Date().toISOString(),
			providerId: "async-pending-mock",
			checkoutReference: "chk_unresolved_ref",
		});

		const result = await reconcilePaymentAttempt(ctx, {
			orderDraftId,
			providerId: "async-pending-mock",
		});

		expect(result.status).toBe("pending");
		expect(result.orderId).toBeUndefined();
	});

	it("reconciles confirmed payment, creates order, and cleans up draft snapshot", async () => {
		const asyncProvider = createMockPaymentProvider({
			id: "async-succeed-mock",
			asyncPendingCheckout: true,
			succeedPaymentStatus: true,
		});
		registerPaymentProvider(asyncProvider);

		const { ctx, getCol } = makeMockContext({
			"settings:paymentProvider": "async-succeed-mock",
		});

		const orderDraftId = "draft_reconcile_success";
		const cart: CartState = {
			sessionId: "sess_rec_success",
			currency: "USD",
			customerEmail: "buyer@example.com",
			billingAddress: defaultAddress,
			shippingAddress: defaultAddress,
			items: [
				{
					lineId: "line_1",
					productId: "prod_1",
					isDigital: true,
					quantity: 1,
					unitPrice: { amount: 5000, currency: "USD" },
					lineSubtotal: { amount: 5000, currency: "USD" },
					title: "Club Jersey",
				},
			],
			coupons: [],
			taxLines: [],
			subtotal: { amount: 5000, currency: "USD" },
			discountTotal: { amount: 0, currency: "USD" },
			shippingTotal: { amount: 0, currency: "USD" },
			taxTotal: { amount: 0, currency: "USD" },
			total: { amount: 5000, currency: "USD" },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		await ctx.kv.set(draftKey(orderDraftId), {
			cart,
			ttlMs: 60000,
			createdAt: new Date().toISOString(),
			providerId: "async-succeed-mock",
			checkoutReference: "chk_rec_success_ref",
		});

		const result = await reconcilePaymentAttempt(ctx, {
			orderDraftId,
			providerId: "async-succeed-mock",
		});

		expect(result.status).toBe("completed");
		expect(result.reconciled).toBe(true);
		expect(result.orderId).toBeDefined();

		// Check order created
		const ordersCol = getCol("orders");
		const orderId = result.orderId ?? "";
		const order = ordersCol.get(orderId) as Order;
		expect(order).toBeDefined();
		expect(order.providerId).toBe("async-succeed-mock");
		expect(order.paymentStatus).toBe("paid");

		// Snapshot should be wiped after completion
		const snapshotAfter = await ctx.kv.get(draftKey(orderDraftId));
		expect(snapshotAfter).toBeNull();
	});

	it("releases lock and marks failed when payment status returns failed", async () => {
		const asyncProvider = createMockPaymentProvider({
			id: "async-fail-mock",
			asyncPendingCheckout: true,
			failPaymentStatus: true,
		});
		registerPaymentProvider(asyncProvider);

		const { ctx } = makeMockContext({
			"settings:paymentProvider": "async-fail-mock",
		});

		const orderDraftId = "draft_fail_1";
		const cart: CartState = {
			sessionId: "sess_fail",
			currency: "USD",
			customerEmail: "buyer@example.com",
			billingAddress: defaultAddress,
			shippingAddress: defaultAddress,
			items: [],
			coupons: [],
			taxLines: [],
			subtotal: { amount: 5000, currency: "USD" },
			discountTotal: { amount: 0, currency: "USD" },
			shippingTotal: { amount: 0, currency: "USD" },
			taxTotal: { amount: 0, currency: "USD" },
			total: { amount: 5000, currency: "USD" },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};

		await ctx.kv.set(draftKey(orderDraftId), {
			cart,
			ttlMs: 60000,
			createdAt: new Date().toISOString(),
			providerId: "async-fail-mock",
			checkoutReference: "chk_fail_ref",
		});

		const result = await reconcilePaymentAttempt(ctx, {
			orderDraftId,
			providerId: "async-fail-mock",
		});

		expect(result.status).toBe("failed");
		expect(result.reason).toContain("failure");
	});

	it("handles late confirmation without duplicate fulfilment if already reconciled", async () => {
		const asyncProvider = createMockPaymentProvider({
			id: "async-late-mock",
			asyncPendingCheckout: true,
			succeedPaymentStatus: true,
		});
		registerPaymentProvider(asyncProvider);

		const { ctx, getCol } = makeMockContext({
			"settings:paymentProvider": "async-late-mock",
		});

		const orderDraftId = "draft_late_confirm";
		// Pre-seed completed order
		const existingOrder: Order = {
			id: "ord_already_paid",
			orderNumber: "003001",
			status: "completed",
			paymentStatus: "paid",
			paymentReference: "pay_prev_captured",
			providerId: "async-late-mock",
			stripePaymentIntentId: "pay_prev_captured",
			customerId: "cust_1",
			customerEmail: "buyer@example.com",
			currency: "USD",
			billingAddress: defaultAddress,
			shippingAddress: defaultAddress,
			subtotal: { amount: 5000, currency: "USD" },
			taxTotal: { amount: 0, currency: "USD" },
			shippingTotal: { amount: 0, currency: "USD" },
			discountTotal: { amount: 0, currency: "USD" },
			total: { amount: 5000, currency: "USD" },
			paidTotal: { amount: 5000, currency: "USD" },
			refundedTotal: { amount: 0, currency: "USD" },
			taxLines: [],
			couponCodes: [],
			lineItemCount: 1,
			metadata: { orderDraftId },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		getCol("orders").set(existingOrder.id, existingOrder);

		// Late webhook arrival for already completed order
		const webhookRoute = webhookRoutes["checkout/webhook"];
		const lateEvent = JSON.stringify({
			type: "charge.succeeded",
			id: "evt_late_arrival_001",
			orderDraftId,
			checkoutReference: "chk_late_ref",
			paymentReference: "pay_late_ref",
			amount: 5000,
			currency: "USD",
			email: "buyer@example.com",
		});

		const webhookRes = await webhookRoute.handler(
			{
				request: new Request("http://test/checkout/webhook", {
					method: "POST",
					headers: { "x-webhook-signature": "test-secret" },
					body: lateEvent,
				}),
				requestMeta: {} as unknown as import("emdash").RouteContext["requestMeta"],
			} as unknown as import("emdash").RouteContext,
			ctx,
		);

		expect(webhookRes.status).toBe(200);

		// Orders collection must still contain only 1 order
		expect(getCol("orders").size).toBe(1);

		// Reconcile attempt also detects existing order and avoids duplicate fulfilment
		const reconcileRes = await reconcilePaymentAttempt(ctx, {
			orderDraftId,
			providerId: "async-late-mock",
		});

		expect(reconcileRes.status).toBe("completed");
		expect(reconcileRes.orderId).toBe("ord_already_paid");
		expect(reconcileRes.reconciled).toBe(false);
	});
});
