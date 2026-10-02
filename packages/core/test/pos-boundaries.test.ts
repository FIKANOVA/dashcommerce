import { describe, expect, it } from "bun:test";
import { OversoldError } from "../src/inventory/decrement";
import { fulfillOrder } from "../src/orders/fulfilment";
import { allocateStock, reconcileAllocation } from "../src/pos/allocation";
import { validateTenderLines } from "../src/pos/tender";
import type { Order, OrderTenderLine } from "../src/types";

function makeMockContext() {
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
					async delete(id: string) {
						col.delete(id);
					},
					async query(opts?: { where?: Record<string, unknown> }) {
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
	productsMap.set("prod_kiosk_1", {
		id: "prod_kiosk_1",
		status: "published",
		data: {
			title: "Matchday Scarf",
			type: "simple",
			prices: { KES: { amount: 200000 } },
			manage_stock: true,
			stock_quantity: 25,
			stock_status: "instock",
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
		storage,
		content,
		log: {
			debug() {},
			info() {},
			warn() {},
			error() {},
		},
	} as unknown as import("emdash").PluginContext;

	return { ctx, getCol, productsMap };
}

describe("POS Tender Boundaries & Semantics", () => {
	const orderTotal = { amount: 3000, currency: "KES" };

	it("accepts exact cash payment", () => {
		const tenders: OrderTenderLine[] = [
			{
				id: "t_1",
				type: "cash",
				amount: { amount: 3000, currency: "KES" },
				status: "completed",
				createdAt: new Date().toISOString(),
			},
		];
		const res = validateTenderLines(orderTotal, tenders);
		expect(res.valid).toBe(true);
		expect(res.changeDue).toBe(0);
	});

	it("accepts overpaying cash tender and calculates change due", () => {
		const tenders: OrderTenderLine[] = [
			{
				id: "t_1",
				type: "cash",
				amount: { amount: 4000, currency: "KES" },
				status: "completed",
				createdAt: new Date().toISOString(),
			},
		];
		const res = validateTenderLines(orderTotal, tenders);
		expect(res.valid).toBe(true);
		expect(res.changeDue).toBe(1000);
	});

	it("rejects overpaying electronic tender (exact amount required)", () => {
		const tenders: OrderTenderLine[] = [
			{
				id: "t_card_1",
				type: "card_terminal",
				amount: { amount: 3500, currency: "KES" },
				status: "completed",
				reference: "term_tx_123",
				createdAt: new Date().toISOString(),
			},
		];
		const res = validateTenderLines(orderTotal, tenders);
		expect(res.valid).toBe(false);
		expect(res.reason).toContain("Exact payment required");
	});

	it("rejects underpaid tenders", () => {
		const tenders: OrderTenderLine[] = [
			{
				id: "t_1",
				type: "cash",
				amount: { amount: 2500, currency: "KES" },
				status: "completed",
				createdAt: new Date().toISOString(),
			},
		];
		const res = validateTenderLines(orderTotal, tenders);
		expect(res.valid).toBe(false);
		expect(res.reason).toContain("Underpaid");
	});

	it("rejects currency mismatch between order and tender", () => {
		const tenders: OrderTenderLine[] = [
			{
				id: "t_1",
				type: "cash",
				amount: { amount: 3000, currency: "USD" },
				status: "completed",
				createdAt: new Date().toISOString(),
			},
		];
		const res = validateTenderLines(orderTotal, tenders);
		expect(res.valid).toBe(false);
		expect(res.reason).toContain("Currency mismatch");
	});

	it("validates split tender: cash + verified terminal", () => {
		const tenders: OrderTenderLine[] = [
			{
				id: "t_1",
				type: "card_terminal",
				amount: { amount: 2000, currency: "KES" },
				status: "completed",
				reference: "term_pos_001",
				createdAt: new Date().toISOString(),
			},
			{
				id: "t_2",
				type: "cash",
				amount: { amount: 1500, currency: "KES" },
				status: "completed",
				createdAt: new Date().toISOString(),
			},
		];
		const res = validateTenderLines(orderTotal, tenders);
		expect(res.valid).toBe(true);
		expect(res.changeDue).toBe(500);
	});

	it("blocks completing split sale while electronic tender is unverified", () => {
		const tenders: OrderTenderLine[] = [
			{
				id: "t_stk_1",
				type: "mpesa_stk",
				amount: { amount: 2000, currency: "KES" },
				status: "pending", // unverified!
				createdAt: new Date().toISOString(),
			},
			{
				id: "t_cash_1",
				type: "cash",
				amount: { amount: 1000, currency: "KES" },
				status: "completed",
				createdAt: new Date().toISOString(),
			},
		];
		const res = validateTenderLines(orderTotal, tenders);
		expect(res.valid).toBe(false);
		expect(res.reason).toContain("electronic tender is unverified or pending");
	});
});

describe("POS Device Stock Allocation & Reconciliation", () => {
	it("allocates stock, decrements online catalog availability, and creates record", async () => {
		const { ctx, productsMap } = makeMockContext();

		const alloc = await allocateStock(ctx, {
			deviceId: "kiosk_gate_a",
			productId: "prod_kiosk_1",
			quantity: 10,
		});

		expect(alloc.id).toBeDefined();
		expect(alloc.allocatedQuantity).toBe(10);
		expect(alloc.soldQuantity).toBe(0);
		expect(alloc.status).toBe("active");

		// Online availability decreased from 25 to 15
		const updatedProduct = productsMap.get("prod_kiosk_1");
		expect(updatedProduct.data.stock_quantity).toBe(15);
	});

	it("throws OversoldError when requested allocation exceeds available stock", async () => {
		const { ctx } = makeMockContext();

		await expect(
			allocateStock(ctx, {
				deviceId: "kiosk_gate_a",
				productId: "prod_kiosk_1",
				quantity: 30, // only 25 available
			}),
		).rejects.toThrow(OversoldError);
	});

	it("reconciles allocation, returning unsold stock back to online inventory", async () => {
		const { ctx, productsMap } = makeMockContext();

		const alloc = await allocateStock(ctx, {
			deviceId: "kiosk_gate_b",
			productId: "prod_kiosk_1",
			quantity: 10,
		});

		// 10 allocated, 15 remaining online
		expect(productsMap.get("prod_kiosk_1")?.data.stock_quantity).toBe(15);

		// Reconcile: device sold 6 units offline, 4 unsold
		const reconciled = await reconcileAllocation(ctx, {
			allocationId: alloc.id,
			soldQuantity: 6,
		});

		expect(reconciled.status).toBe("reconciled");
		expect(reconciled.soldQuantity).toBe(6);

		// 4 unsold returned -> online stock becomes 15 + 4 = 19
		expect(productsMap.get("prod_kiosk_1")?.data.stock_quantity).toBe(19);

		// Second reconciliation attempt fails
		await expect(
			reconcileAllocation(ctx, {
				allocationId: alloc.id,
				soldQuantity: 6,
			}),
		).rejects.toThrow(/already reconciled/);
	});

	it("rejects soldQuantity greater than allocatedQuantity", async () => {
		const { ctx } = makeMockContext();

		const alloc = await allocateStock(ctx, {
			deviceId: "kiosk_gate_c",
			productId: "prod_kiosk_1",
			quantity: 5,
		});

		await expect(
			reconcileAllocation(ctx, {
				allocationId: alloc.id,
				soldQuantity: 10,
			}),
		).rejects.toThrow(/cannot exceed allocated/);
	});
});

describe("Order Fulfilment Idempotency Boundary", () => {
	it("records fulfilment, updates order status, and replay with same key returns prior result", async () => {
		const { ctx, getCol } = makeMockContext();

		const order: Order = {
			id: "order_fulfil_1",
			orderNumber: "005001",
			status: "processing",
			paymentStatus: "paid",
			stripePaymentIntentId: "pi_fulfil_1",
			customerId: "cust_1",
			customerEmail: "cust@example.com",
			currency: "KES",
			billingAddress: { line1: "Ngong Rd", city: "Nairobi", country: "KE" },
			shippingAddress: { line1: "Ngong Rd", city: "Nairobi", country: "KE" },
			subtotal: { amount: 200000, currency: "KES" },
			taxTotal: { amount: 0, currency: "KES" },
			shippingTotal: { amount: 0, currency: "KES" },
			discountTotal: { amount: 0, currency: "KES" },
			total: { amount: 200000, currency: "KES" },
			paidTotal: { amount: 200000, currency: "KES" },
			refundedTotal: { amount: 0, currency: "KES" },
			taxLines: [],
			couponCodes: [],
			lineItemCount: 1,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		getCol("orders").set(order.id, order);

		// First fulfilment attempt
		const fulfilment1 = await fulfillOrder(ctx, {
			orderId: order.id,
			idempotencyKey: "fulfil_key_001",
			trackingNumber: "TRK123456",
			carrier: "G4S",
			items: [{ orderItemId: "item_1", quantity: 1 }],
		});

		expect(fulfilment1.id).toBeDefined();
		expect(fulfilment1.status).toBe("fulfilled");
		expect(fulfilment1.trackingNumber).toBe("TRK123456");

		// Order advanced to completed
		const updatedOrder = getCol("orders").get(order.id) as Order;
		expect(updatedOrder.status).toBe("completed");

		// Replay with exact same idempotencyKey returns existing fulfilment
		const fulfilmentReplay = await fulfillOrder(ctx, {
			orderId: order.id,
			idempotencyKey: "fulfil_key_001",
			trackingNumber: "TRK123456",
			carrier: "G4S",
			items: [{ orderItemId: "item_1", quantity: 1 }],
		});

		expect(fulfilmentReplay.id).toBe(fulfilment1.id);

		// Replay with same key but different order throws conflict
		await expect(
			fulfillOrder(ctx, {
				orderId: "order_different_999",
				idempotencyKey: "fulfil_key_001",
				items: [{ orderItemId: "item_1", quantity: 1 }],
			}),
		).rejects.toThrow(/Conflict.*already processed/);
	});
});
