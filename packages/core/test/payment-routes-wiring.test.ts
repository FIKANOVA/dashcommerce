import { beforeEach, describe, expect, it } from "bun:test";
import { checkoutRoutes, draftKey } from "../src/routes/checkout";
import { webhookRoutes } from "../src/routes/webhook";
import { refundOrder } from "../src/orders/refund";
import {
	createMockPaymentProvider,
	registerPaymentProvider,
	resetPaymentProviders,
} from "../src/payment-provider";
import type { CartState, Order } from "../src/types";

function makeMockContext(initialKv?: Record<string, unknown>) {
	const kvStore = new Map<string, unknown>(Object.entries(initialKv ?? {}));
	const collections = new Map<string, Map<string, unknown>>();

	function getCol(name: string) {
		if (!collections.has(name)) {
			collections.set(name, new Map());
		}
		return collections.get(name)!;
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
					async put(id: string, data: any) {
						col.set(id, data);
					},
					async putMany(items: Array<{ id: string; data: any }>) {
						for (const item of items) {
							col.set(item.id, item.data);
						}
					},
					async delete(id: string) {
						col.delete(id);
					},
					async query(opts?: { where?: Record<string, any> }) {
						const all = Array.from(col.entries()).map(([id, data]) => ({
							id,
							data,
						}));
						if (!opts?.where) return { items: all, hasMore: false };
						const filtered = all.filter((item) => {
							const d = item.data as any;
							for (const [k, v] of Object.entries(opts.where!)) {
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

	const productsMap = new Map<string, any>();
	productsMap.set("prod_1", {
		id: "prod_1",
		status: "published",
		data: {
			title: "Club Jersey",
			type: "simple",
			prices: {
				USD: { amount: 5000 },
				KES: { amount: 500000 },
				EUR: { amount: 5000 },
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
				return Array.from(kvStore.keys()).filter((k) =>
					prefix ? k.startsWith(prefix) : true,
				);
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

function makeRouteCtx(
	pathname: string,
	input: unknown = {},
	headers: Record<string, string> = {},
	method = "POST",
): import("emdash").RouteContext {
	return {
		input,
		request: new Request(`http://test${pathname}`, {
			method,
			headers,
			body: method !== "GET" ? JSON.stringify(input) : undefined,
		}),
		requestMeta: {
			ip: "127.0.0.1",
			userAgent: "test-agent",
			referer: null,
			geo: null,
		},
	} as unknown as import("emdash").RouteContext;
}

const defaultAddress = {
	firstName: "Juma",
	lastName: "Otieno",
	line1: "Ngong Road",
	city: "Nairobi",
	country: "KE",
};

describe("Generic PaymentProvider Route Wiring & Boundaries", () => {
	beforeEach(() => {
		resetPaymentProviders();
	});

	describe("Checkout route wiring", () => {
		it("rejects currency unsupported by the resolved payment provider", async () => {
			const mockProvider = createMockPaymentProvider({
				id: "custom-mock",
				supportedCurrencies: ["USD"],
			});
			registerPaymentProvider(mockProvider);

			const { ctx } = makeMockContext({
				"settings:paymentProvider": "custom-mock",
			});

			const cart: CartState = {
				sessionId: "cart_1",
				currency: "EUR", // not supported by custom-mock
				billingAddress: defaultAddress,
				shippingAddress: defaultAddress,
				items: [
					{
						lineId: "line_1",
						productId: "prod_1",
						isDigital: true,
						quantity: 1,
						unitPrice: { amount: 5000, currency: "EUR" },
						lineSubtotal: { amount: 5000, currency: "EUR" },
						title: "Club Jersey",
					},
				],
				coupons: [],
				taxLines: [],
				subtotal: { amount: 5000, currency: "EUR" },
				discountTotal: { amount: 0, currency: "EUR" },
				shippingTotal: { amount: 0, currency: "EUR" },
				taxTotal: { amount: 0, currency: "EUR" },
				total: { amount: 5000, currency: "EUR" },
				customerEmail: "buyer@example.com",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			await ctx.kv.set("cart:cart_1", cart);

			const route = checkoutRoutes["checkout/create-session"];
			const res = await route.handler(
				makeRouteCtx(
					"/checkout/create-session",
					{ customerEmail: "buyer@example.com" },
					{ cookie: "dashcommerce_sid=cart_1" },
				),
				ctx,
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			expect(body.error).toContain("is not supported by payment provider");
		});

		it("initializes checkout through active provider and returns separated references", async () => {
			const mockProvider = createMockPaymentProvider({
				id: "mock",
			});
			registerPaymentProvider(mockProvider, { override: true });

			const { ctx } = makeMockContext({
				"settings:paymentProvider": "mock",
			});

			const cart: CartState = {
				sessionId: "cart_123",
				currency: "USD",
				billingAddress: defaultAddress,
				shippingAddress: defaultAddress,
				items: [
					{
						lineId: "line_1",
						productId: "prod_1",
						isDigital: true,
						quantity: 2,
						unitPrice: { amount: 5000, currency: "USD" },
						lineSubtotal: { amount: 10000, currency: "USD" },
						title: "Club Jersey",
					},
				],
				coupons: [],
				taxLines: [],
				subtotal: { amount: 10000, currency: "USD" },
				discountTotal: { amount: 0, currency: "USD" },
				shippingTotal: { amount: 0, currency: "USD" },
				taxTotal: { amount: 0, currency: "USD" },
				total: { amount: 10000, currency: "USD" },
				customerEmail: "buyer@example.com",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			await ctx.kv.set("cart:cart_123", cart);

			const route = checkoutRoutes["checkout/create-session"];
			const res = await route.handler(
				makeRouteCtx(
					"/checkout/create-session",
					{ customerEmail: "buyer@example.com" },
					{ cookie: "dashcommerce_sid=cart_123" },
				),
				ctx,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as any;
			expect(body.kind).toBe("redirect");
			expect(body.providerId).toBe("mock");
			expect(body.sessionId).toBeDefined();
			expect(body.checkoutReference).toBe(body.sessionId);
			expect(body.url).toContain("mock=1");
			expect(body.orderDraftId).toBeDefined();

			// Verify draft snapshot was saved
			const snapshot = await ctx.kv.get(draftKey(body.orderDraftId));
			expect(snapshot).toBeDefined();
		});

		it("supports asynchronous pending checkout kind", async () => {
			const asyncProvider = createMockPaymentProvider({
				id: "async-mock",
				asyncPendingCheckout: true,
			});
			registerPaymentProvider(asyncProvider);

			const { ctx } = makeMockContext({
				"settings:paymentProvider": "async-mock",
			});

			const cart: CartState = {
				sessionId: "cart_async",
				currency: "USD",
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
				customerEmail: "buyer@example.com",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			await ctx.kv.set("cart:cart_async", cart);

			const route = checkoutRoutes["checkout/create-session"];
			const res = await route.handler(
				makeRouteCtx(
					"/checkout/create-session",
					{ customerEmail: "buyer@example.com" },
					{ cookie: "dashcommerce_sid=cart_async" },
				),
				ctx,
			);

			expect(res.status).toBe(200);
			const body = (await res.json()) as any;
			expect(body.kind).toBe("pending");
			expect(body.status).toBe("pending");
			expect(body.checkoutReference).toBeDefined();
			expect(body.url).toBeUndefined();
		});

		it("checkout/status returns order status with no-store cache headers", async () => {
			const { ctx, getCol } = makeMockContext();

			const orderDraftId = "draft_stat_001";
			await ctx.kv.set(draftKey(orderDraftId), {
				cart: { sessionId: "session_owner" },
				ttlMs: 60000,
				createdAt: new Date().toISOString(),
				providerId: "mock",
				checkoutReference: "chk_stat_999",
			});

			const statusRoute = checkoutRoutes["checkout/status"];

			// Test 1: Active pending draft
			const resPending = await statusRoute.handler(
				makeRouteCtx(
					`/checkout/status?orderDraftId=${orderDraftId}`,
					{},
					{ cookie: "dashcommerce_sid=session_owner" },
					"GET",
				),
				ctx,
			);
			expect(resPending.status).toBe(200);
			expect(resPending.headers.get("Cache-Control")).toBe("no-store");
			const bodyPending = (await resPending.json()) as any;
			expect(bodyPending.status).toBe("pending");
			expect(bodyPending.checkoutReference).toBe("chk_stat_999");

			// Test 2: Order completed
			const order: Order = {
				id: "ord_completed_1",
				orderNumber: 2001,
				status: "completed",
				paymentStatus: "paid",
				paymentReference: "pay_captured_stat_1",
				stripePaymentIntentId: "pay_captured_stat_1",
				customerId: "cust_1",
				customerEmail: "cust@example.com",
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
			getCol("orders").set(order.id, order);

			const resCompleted = await statusRoute.handler(
				makeRouteCtx(
					`/checkout/status?orderDraftId=${orderDraftId}`,
					{},
					{ cookie: "dashcommerce_sid=session_owner" },
					"GET",
				),
				ctx,
			);
			expect(resCompleted.status).toBe(200);
			const bodyCompleted = (await resCompleted.json()) as any;
			expect(bodyCompleted.status).toBe("completed");
			expect(bodyCompleted.orderId).toBe(order.id);
			expect(bodyCompleted.orderNumber).toBe(2001);

			// Test 3: Expired / nonexistent draft
			const resExpired = await statusRoute.handler(
				makeRouteCtx("/checkout/status?orderDraftId=nonexistent", {}, {}, "GET"),
				ctx,
			);
			expect(resExpired.status).toBe(200);
			const bodyExpired = (await resExpired.json()) as any;
			expect(bodyExpired.status).toBe("expired");
		});
	});

	describe("Webhook route wiring & event deduplication", () => {
		it("rejects webhook if signature is invalid", async () => {
			const mockProvider = createMockPaymentProvider({ id: "mock" });
			registerPaymentProvider(mockProvider, { override: true });

			const { ctx } = makeMockContext({
				"settings:paymentProvider": "mock",
			});

			const payload = JSON.stringify({ type: "charge.succeeded" });
			const route = webhookRoutes["checkout/webhook"];
			const res = await route.handler(
				{
					request: new Request("http://test/checkout/webhook", {
						method: "POST",
						headers: {
							"x-webhook-signature": "wrong-secret",
						},
						body: payload,
					}),
					requestMeta: {} as any,
				} as any,
				ctx,
			);

			expect(res.status).toBe(400);
			const body = (await res.json()) as any;
			expect(body.error).toContain("Invalid signature");
		});

		it("processes charge.succeeded, creates order with separated references, and deduplicates identical events", async () => {
			const mockProvider = createMockPaymentProvider({ id: "mock" });
			registerPaymentProvider(mockProvider, { override: true });

			const { ctx, getCol } = makeMockContext({
				"settings:paymentProvider": "mock",
			});

			const orderDraftId = "draft_test_123";
			const cart: CartState = {
				sessionId: "cart_webhook",
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
				providerId: "mock",
				checkoutReference: "chk_ref_999",
			});

			const eventPayload = JSON.stringify({
				type: "charge.succeeded",
				id: "evt_native_001",
				orderDraftId,
				checkoutReference: "chk_ref_999",
				paymentReference: "pay_captured_888",
				amount: 5000,
				currency: "USD",
				email: "buyer@example.com",
			});

			const route = webhookRoutes["checkout/webhook"];

			// First delivery: processes order
			const res1 = await route.handler(
				{
					request: new Request("http://test/checkout/webhook", {
						method: "POST",
						headers: {
							"x-webhook-signature": "test-secret",
						},
						body: eventPayload,
					}),
					requestMeta: {} as any,
				} as any,
				ctx,
			);

			expect(res1.status).toBe(200);
			const body1 = (await res1.json()) as any;
			expect(body1.received).toBe(true);
			expect(body1.orderId).toBeDefined();

			// Verify order in storage has separated references
			const ordersCol = getCol("orders");
			const createdOrder = ordersCol.get(body1.orderId) as Order;
			expect(createdOrder).toBeDefined();
			expect(createdOrder.providerId).toBe("mock");
			expect(createdOrder.paymentReference).toBe("pay_captured_888");
			expect(createdOrder.checkoutReference).toBe("chk_ref_999");
			expect(createdOrder.paymentStatus).toBe("paid");

			// Second delivery with identical eventId: must short-circuit as duplicate without creating another order
			const res2 = await route.handler(
				{
					request: new Request("http://test/checkout/webhook", {
						method: "POST",
						headers: {
							"x-webhook-signature": "test-secret",
						},
						body: eventPayload,
					}),
					requestMeta: {} as any,
				} as any,
				ctx,
			);

			expect(res2.status).toBe(200);
			const body2 = (await res2.json()) as any;
			expect(body2.received).toBe(true);
			expect(body2.duplicate).toBe(true);

			// Count of orders must still be 1
			expect(ordersCol.size).toBe(1);
		});
	});

	describe("Refund operation routing & idempotency", () => {
		it("routes refund to order provider and replaying with same key returns prior result", async () => {
			const mockProvider = createMockPaymentProvider({ id: "mock" });
			registerPaymentProvider(mockProvider, { override: true });

			const { ctx, getCol } = makeMockContext({
				"settings:paymentProvider": "mock",
			});

			// Seed an existing order in storage
			const orderId = "order_ref_1";
			const order: Order = {
				id: orderId,
				orderNumber: 1001,
				status: "completed",
				paymentStatus: "paid",
				paymentReference: "pay_captured_mock_1",
				providerId: "mock",
				stripePaymentIntentId: "pay_captured_mock_1",
				customerId: "cust_1",
				customerEmail: "customer@example.com",
				currency: "USD",
				billingAddress: {
					line1: "123 Main St",
					city: "Nairobi",
					country: "KE",
				},
				shippingAddress: {
					line1: "123 Main St",
					city: "Nairobi",
					country: "KE",
				},
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
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			getCol("orders").set(orderId, order);

			// Perform refund 1
			const refund1 = await refundOrder(ctx, {
				orderId,
				amount: { amount: 2000, currency: "USD" },
				reason: "Customer request",
				idempotencyKey: "ref_req_alpha",
			});

			expect(refund1.status).toBe("succeeded");
			expect(refund1.amount.amount).toBe(2000);
			expect(refund1.refundRequestId).toBe("ref_req_alpha");
			expect(refund1.providerId).toBe("mock");

			// Replay with exact same idempotencyKey and same amount: returns prior refund
			const refundReplay = await refundOrder(ctx, {
				orderId,
				amount: { amount: 2000, currency: "USD" },
				reason: "Customer request",
				idempotencyKey: "ref_req_alpha",
			});

			expect(refundReplay.id).toBe(refund1.id);
			expect(refundReplay.refundRequestId).toBe("ref_req_alpha");

			// Replay with exact same idempotencyKey but DIFFERENT amount: throws conflict
			await expect(
				refundOrder(ctx, {
					orderId,
					amount: { amount: 3000, currency: "USD" },
					reason: "Customer request changed amount",
					idempotencyKey: "ref_req_alpha",
				}),
			).rejects.toThrow(/Conflict.*already processed/);
		});
	});
});
