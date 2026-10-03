/**
 * Demonstrates that @dashcommerce/palpluss can be installed, registered,
 * and used through public @dashcommerce/core APIs without modifying core code.
 */

import { describe, expect, it } from "bun:test";
import sandbox from "@dashcommerce/core/sandbox";
import {
	registerPaymentProvider,
	resolveProvider,
} from "@dashcommerce/core/payment-provider";
import type { CartState } from "@dashcommerce/core";
import { palplussPaymentProvider } from "../src/provider";
import type { PalplussCredentials } from "../src/types";

function makeMockPalplussContext(
	initialKv: Record<string, unknown> = {},
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>,
) {
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
		if (url.includes("/v1/payments/stk")) {
			return new Response(
				JSON.stringify({
					status: "PENDING",
					transactionId: "TXN_STK_INTEGRATION_001",
					message: "STK push initiated",
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		}
		if (url.includes("/v1/payments/TXN_STK_INTEGRATION_001")) {
			return new Response(
				JSON.stringify({
					status: "SUCCESS",
					transactionId: "TXN_STK_INTEGRATION_001",
					reference: "TXN_STK_INTEGRATION_001",
					amount: 1500,
					currency: "KES",
					mpesaReceipt: "QK99887766",
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
			title: "Nondies Matchday Ticket",
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
	};

	return { ctx, kvStore, getCol };
}

describe("PalPluss Core Route Integration", () => {
	const credentials: PalplussCredentials = {
		apiKey: "palpluss_sec_key_123",
		channelId: "543210",
		callbackUrl: "https://example.com/api/checkout/webhook",
	};

	it("registers into core provider registry and resolves correctly", async () => {
		registerPaymentProvider(palplussPaymentProvider, { override: true });

		const { ctx } = makeMockPalplussContext({
			"settings:paymentProvider": "palpluss",
			"settings:paymentProviderCredentials": credentials,
		});

		const provider = await resolveProvider(ctx.kv);
		expect(provider.id).toBe("palpluss");
		expect(provider.label).toBe("PalPluss (M-Pesa STK)");
		expect(provider.supportsCurrency("KES")).toBe(true);
		expect(provider.supportsCurrency("USD")).toBe(false);
	});

	it("executes checkout/create-session via public core route with kind: pending", async () => {
		registerPaymentProvider(palplussPaymentProvider, { override: true });

		const sessionId = "sess_palpluss_integ_001";
		const { ctx } = makeMockPalplussContext({
			"settings:paymentProvider": "palpluss",
			"settings:paymentProviderCredentials": credentials,
			"settings:currency": "KES",
		});

		const cart: CartState = {
			sessionId,
			currency: "KES",
			customerEmail: "supporter@nondies.co.ke",
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
					title: "Nondies Matchday Ticket",
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

		const checkoutRoute = sandbox.routes["checkout/create-session"];
		expect(checkoutRoute).toBeDefined();

		const request = new Request("https://nondies.example.com/api/checkout/create-session", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Cookie: `dashcommerce_sid=${sessionId}`,
			},
			body: JSON.stringify({
				customerEmail: "supporter@nondies.co.ke",
				customerName: "Supporter One",
				phone: "0712345678",
			}),
		});

		const routeCtx = {
			...ctx,
			request,
			input: {
				customerEmail: "supporter@nondies.co.ke",
				customerName: "Supporter One",
				phone: "0712345678",
			},
		} as unknown as import("emdash").RouteContext;

		const response = (await checkoutRoute.handler(routeCtx, ctx)) as Response;
		expect(response.status).toBe(200);

		const body = (await response.json()) as any;
		expect(body.kind).toBe("pending");
		expect(body.status).toBe("pending");
		expect(body.checkoutReference).toBe("TXN_STK_INTEGRATION_001");
		expect(body.orderDraftId).toBeDefined();

		// Check draft snapshot in KV
		const draftSnapshot = await ctx.kv.get<any>(`draft:${body.orderDraftId}`);
		expect(draftSnapshot).toBeDefined();
		expect(draftSnapshot.providerId).toBe("palpluss");
		expect(draftSnapshot.checkoutReference).toBe("TXN_STK_INTEGRATION_001");

		// Execute status check via public core route `checkout/status`
		const statusRoute = sandbox.routes["checkout/status"];
		expect(statusRoute).toBeDefined();

		const statusRequest = new Request(
			`https://nondies.example.com/api/checkout/status?orderDraftId=${body.orderDraftId}`,
			{
				method: "GET",
				headers: {
					Cookie: `dashcommerce_sid=${sessionId}`,
				},
			},
		);

		const statusRouteCtx = {
			...ctx,
			request: statusRequest,
		} as unknown as import("emdash").RouteContext;

		const statusResponse = (await statusRoute.handler(statusRouteCtx, ctx)) as Response;
		expect(statusResponse.status).toBe(200);

		const statusData = (await statusResponse.json()) as any;
		expect(statusData.status).toBe("pending");
		expect(statusData.checkoutReference).toBe("TXN_STK_INTEGRATION_001");
	});
});
