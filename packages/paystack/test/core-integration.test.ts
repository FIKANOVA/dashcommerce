/**
 * Demonstrates that @dashcommerce/paystack can be installed, registered,
 * and used through public @dashcommerce/core APIs without modifying core code.
 */

import { describe, expect, it } from "bun:test";
import sandbox from "@dashcommerce/core/sandbox";
import {
	getPaymentProvider,
	registerPaymentProvider,
	resolveProvider,
} from "@dashcommerce/core/payment-provider";
import type { CartState, Order } from "@dashcommerce/core";
import { paystackPaymentProvider } from "../src/provider";

async function generatePaystackSignature(secret: string, payload: string): Promise<string> {
	const enc = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-512" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function makeMockIntegrationContext(initialKv: Record<string, unknown> = {}, fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>) {
	const kvStore = new Map<string, unknown>(Object.entries(initialKv));
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

	const defaultFetch = async (url: string, init?: RequestInit) => {
		if (url.includes("/transaction/initialize")) {
			return new Response(
				JSON.stringify({
					status: true,
					message: "Authorization URL created",
					data: {
						authorization_url: "https://checkout.paystack.com/int_test_abc",
						access_code: "int_test_abc",
						reference: "chk_paystack_integration_123",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url.includes("/transaction/verify")) {
			return new Response(
				JSON.stringify({
					status: true,
					message: "Verification successful",
					data: {
						id: 55443322,
						status: "success",
						reference: "chk_paystack_integration_123",
						amount: 150000,
						currency: "KES",
						channel: "mobile_money",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url.includes("/refund")) {
			return new Response(
				JSON.stringify({
					status: true,
					message: "Refund processed",
					data: {
						id: 887766,
						status: "processed",
						amount: 150000,
						currency: "KES",
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		return new Response("Not found", { status: 404 });
	};

	const productsMap = new Map<string, { id: string; status: string; data: Record<string, unknown> }>();
	productsMap.set("prod_nondies_match_ticket", {
		id: "prod_nondies_match_ticket",
		status: "published",
		data: {
			title: "Nondies Matchday VIP Ticket",
			type: "simple",
			prices: { KES: { amount: 150000 } },
			virtual: true,
			manage_stock: false,
		},
	});

	const content = {
		async get(collection: string, id: string) {
			if (collection === "products") return productsMap.get(id) ?? null;
			return null;
		},
	};

	const ctx = {
		kv: {
			async get<T>(key: string): Promise<T | null> {
				return (kvStore.get(key) as T) ?? null;
			},
			async set(key: string, value: unknown): Promise<void> {
				kvStore.set(key, value);
			},
			async delete(key: string): Promise<void> {
				kvStore.delete(key);
			},
		},
		storage,
		content,
		http: {
			fetch: fetchImpl ?? defaultFetch,
		},
		log: {
			debug() {},
			info() {},
			warn() {},
			error() {},
		},
	} as unknown as import("emdash").PluginContext;

	return { ctx, kvStore, getCol };
}

describe("Paystack Extensibility via Public Core APIs", () => {
	const secretKey = "sk_test_paystack_integration_secret";

	it("registers paystack into core registry without mutating core source", async () => {
		registerPaymentProvider(paystackPaymentProvider, { override: true });
		const registered = getPaymentProvider("paystack");
		expect(registered).toBeDefined();
		expect(registered?.id).toBe("paystack");
		expect(registered?.label).toBe("Paystack");
		expect(registered?.supportsCurrency("KES")).toBe(true);

		const { ctx } = makeMockIntegrationContext({
			"settings:paymentProvider": "paystack",
		});
		const resolved = await resolveProvider(ctx.kv);
		expect(resolved.id).toBe("paystack");
	});

	it("executes full checkout -> webhook -> status -> refund loop via public plugin routes", async () => {
		registerPaymentProvider(paystackPaymentProvider, { override: true });

		const { ctx, getCol } = makeMockIntegrationContext({
			"settings:paymentProvider": "paystack",
			"settings:paystackSecretKey": secretKey,
			"settings:currency": "KES",
		});

		// Read routes from public sandbox entry export
		const checkoutRoute = sandbox.routes["checkout/create-session"];
		const webhookRoute = sandbox.routes["checkout/webhook"];
		const statusRoute = sandbox.routes["checkout/status"];

		expect(checkoutRoute).toBeDefined();
		expect(webhookRoute).toBeDefined();
		expect(statusRoute).toBeDefined();

		// 1. Prepare Cart in KV (digital item so no physical shipping method required)
		const sessionId = "sess_paystack_buyer_1";
		const cart: CartState = {
			sessionId,
			currency: "KES",
			customerEmail: "supporter@nondies.ke",
			billingAddress: {
				line1: "Ngong Road",
				city: "Nairobi",
				country: "KE",
			},
			shippingAddress: {
				line1: "Ngong Road",
				city: "Nairobi",
				country: "KE",
			},
			items: [
				{
					lineId: "line_1",
					productId: "prod_nondies_match_ticket",
					quantity: 1,
					title: "Nondies Matchday VIP Ticket",
					isDigital: true,
					unitPrice: { amount: 150000, currency: "KES" },
					lineSubtotal: { amount: 150000, currency: "KES" },
				},
			],
			coupons: [],
			taxLines: [],
			subtotal: { amount: 150000, currency: "KES" },
			discountTotal: { amount: 0, currency: "KES" },
			shippingTotal: { amount: 0, currency: "KES" },
			taxTotal: { amount: 0, currency: "KES" },
			total: { amount: 150000, currency: "KES" },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		await ctx.kv.set(`cart:${sessionId}`, cart);

		// 2. Initiate Checkout via core route `checkout/create-session`
		const initReq = new Request("http://test/checkout/create-session", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: `dashcommerce_sid=${sessionId}`,
			},
			body: JSON.stringify({
				customerEmail: "supporter@nondies.ke",
			}),
		});

		const initRouteCtx = {
			...ctx,
			request: initReq,
			input: {
				customerEmail: "supporter@nondies.ke",
			},
		} as unknown as import("emdash").RouteContext;

		const initRes = (await checkoutRoute.handler(initRouteCtx, ctx)) as Response;
		expect(initRes.status).toBe(200);

		const initData = (await initRes.json()) as { url: string; orderDraftId: string };
		expect(initData.url).toBe("https://checkout.paystack.com/int_test_abc");
		expect(initData.orderDraftId).toBeDefined();

		const orderDraftId = initData.orderDraftId;

		// 3. Deliver Webhook via core route `checkout/webhook`
		const webhookEventPayload = JSON.stringify({
			event: "charge.success",
			data: {
				id: 55443322,
				reference: "chk_paystack_integration_123",
				amount: 150000,
				currency: "KES",
				status: "success",
				customer: {
					email: "supporter@nondies.ke",
					first_name: "Aidi",
					last_name: "Onyango",
					phone: "+254700000000",
				},
				channel: "mobile_money",
				metadata: {
					orderDraftId,
					checkoutReference: "chk_paystack_integration_123",
				},
			},
		});

		const signature = await generatePaystackSignature(secretKey, webhookEventPayload);

		const webhookReq = new Request("http://test/checkout/webhook", {
			method: "POST",
			headers: {
				"x-paystack-signature": signature,
			},
			body: webhookEventPayload,
		});

		const webhookRouteCtx = {
			...ctx,
			request: webhookReq,
		} as unknown as import("emdash").RouteContext;

		const webhookRes = (await webhookRoute.handler(webhookRouteCtx, ctx)) as Response;
		expect(webhookRes.status).toBe(200);

		// 4. Verify Order created in core storage
		const ordersCol = getCol("orders");
		expect(ordersCol.size).toBe(1);

		const order = Array.from(ordersCol.values())[0] as Order;
		expect(order).toBeDefined();
		expect(order.providerId).toBe("paystack");
		expect(order.paymentReference).toBe("55443322");
		expect(order.checkoutReference).toBe("chk_paystack_integration_123");
		expect(order.total.amount).toBe(150000);
		expect(order.total.currency).toBe("KES");
		expect(order.paymentStatus).toBe("paid");

		// 5. Check order status via core route `checkout/status`
		const statusReq = new Request(`http://test/checkout/status?orderDraftId=${orderDraftId}`);
		const statusRouteCtx = {
			...ctx,
			request: statusReq,
		} as unknown as import("emdash").RouteContext;

		const statusRes = (await statusRoute.handler(statusRouteCtx, ctx)) as Response;
		expect(statusRes.status).toBe(200);
		const statusData = (await statusRes.json()) as { status: string; orderId: string };
		expect(statusData.status).toBe("completed");
		expect(statusData.orderId).toBe(order.id);

		// 6. Test Webhook Deduplication: Replaying same webhook must NOT create duplicate order
		const replayReq = new Request("http://test/checkout/webhook", {
			method: "POST",
			headers: {
				"x-paystack-signature": signature,
			},
			body: webhookEventPayload,
		});
		const replayRouteCtx = {
			...ctx,
			request: replayReq,
		} as unknown as import("emdash").RouteContext;

		const replayRes = (await webhookRoute.handler(replayRouteCtx, ctx)) as Response;
		expect(replayRes.status).toBe(200);
		const replayData = (await replayRes.json()) as { duplicate?: boolean };
		expect(replayData.duplicate).toBe(true);
		expect(ordersCol.size).toBe(1);

		// 7. Test Refund via paystack provider refund API with explicit idempotency
		const refundResult = await paystackPaymentProvider.refund(
			{
				http: ctx.http,
				log: ctx.log,
			},
			{
				refundRequestId: "req_refund_paystack_001",
				paymentReference: order.paymentReference ?? "",
				amount: 150000,
				currency: "KES",
				reason: "Customer requested return",
			},
			{ secretKey },
		);

		expect(refundResult.status).toBe("succeeded");
		expect(refundResult.providerRefundId).toBe("887766");
		expect(refundResult.amount).toBe(150000);
		expect(refundResult.currency).toBe("KES");
	});
});
