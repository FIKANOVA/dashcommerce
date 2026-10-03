import { beforeEach, describe, expect, it } from "bun:test";
import { TabFencingError, TabLockManager } from "../src/ledger/fencing";
import { PosLedger } from "../src/ledger/ledger";
import { MemoryPosStorageAdapter } from "../src/ledger/storage";
import type { PosOperatorSession } from "../src/types";

describe("PosLedger & Tab Fencing", () => {
	let storage: MemoryPosStorageAdapter;
	let session: PosOperatorSession;

	beforeEach(async () => {
		TabLockManager.resetAll();
		storage = new MemoryPosStorageAdapter();
		session = {
			operatorId: "op_moseti",
			operatorName: "Moseti",
			deviceId: "kiosk_01",
			authenticatedAt: new Date().toISOString(),
			expiresAt: new Date(Date.now() + 3600000).toISOString(),
			permissions: ["pos:sell", "pos:void"],
		};

		// Provision device stock allocation
		await storage.saveAllocation({
			productId: "prod_jersey",
			deviceId: "kiosk_01",
			allocatedQuantity: 10,
			soldQuantity: 0,
			availableQuantity: 10,
			expiresAt: new Date(Date.now() + 3600000).toISOString(),
		});
	});

	it("enforces multi-tab fencing: secondary tab cannot commit sales", async () => {
		const tab1Manager = new TabLockManager({
			deviceId: "kiosk_01",
			tabId: "tab_primary",
		});
		expect(tab1Manager.acquireLease()).toBe(true);

		const tab2Manager = new TabLockManager({
			deviceId: "kiosk_01",
			tabId: "tab_secondary",
		});
		expect(tab2Manager.acquireLease()).toBe(false);
		expect(() => tab2Manager.assertCanWrite()).toThrow(TabFencingError);
	});

	it("creates a completed cash sale, increments sequence, and updates stock allocation", async () => {
		const ledger = new PosLedger({
			storage,
			deviceId: "kiosk_01",
			tabId: "tab_01",
		});

		const sale = await ledger.createSale({
			merchantId: "merch_nondies",
			locationId: "loc_jamhuri",
			deviceId: "kiosk_01",
			catalogueVersion: "cat_v1",
			currency: "KES",
			lines: [
				{
					productId: "prod_jersey",
					title: "Nondies Home Jersey",
					quantity: 2,
					unitPrice: 500000, // KES 5,000.00
					tax: 0,
					lineSubtotal: 1000000, // KES 10,000.00
				},
			],
			tenders: [
				{
					id: "t_cash_1",
					type: "cash",
					amount: 1000000,
					currency: "KES",
					verified: true,
				},
			],
			session,
		});

		expect(sale.status).toBe("completed");
		expect(sale.deviceSequence).toBe(1);
		expect(sale.total).toBe(1000000);

		// Check stock allocation decrement
		const alloc = await storage.getAllocation("prod_jersey");
		expect(alloc?.soldQuantity).toBe(2);
		expect(alloc?.availableQuantity).toBe(8);

		// Second sale gets sequence 2
		const sale2 = await ledger.createSale({
			merchantId: "merch_nondies",
			locationId: "loc_jamhuri",
			deviceId: "kiosk_01",
			catalogueVersion: "cat_v1",
			currency: "KES",
			lines: [
				{
					productId: "prod_jersey",
					title: "Nondies Home Jersey",
					quantity: 1,
					unitPrice: 500000,
					tax: 0,
					lineSubtotal: 500000,
				},
			],
			tenders: [
				{
					id: "t_cash_2",
					type: "cash",
					amount: 500000,
					currency: "KES",
					verified: true,
				},
			],
			session,
		});

		expect(sale2.deviceSequence).toBe(2);
	});

	it("creates an append-only reversal that voids original sale and restores allocation", async () => {
		const ledger = new PosLedger({
			storage,
			deviceId: "kiosk_01",
			tabId: "tab_01",
		});

		const original = await ledger.createSale({
			merchantId: "merch_nondies",
			locationId: "loc_jamhuri",
			deviceId: "kiosk_01",
			catalogueVersion: "cat_v1",
			currency: "KES",
			lines: [
				{
					productId: "prod_jersey",
					title: "Nondies Home Jersey",
					quantity: 3,
					unitPrice: 500000,
					tax: 0,
					lineSubtotal: 1500000,
				},
			],
			tenders: [
				{
					id: "t_cash_1",
					type: "cash",
					amount: 1500000,
					currency: "KES",
					verified: true,
				},
			],
			session,
		});

		let alloc = await storage.getAllocation("prod_jersey");
		expect(alloc?.soldQuantity).toBe(3);

		const reversal = await ledger.createReversal({
			originalOperationId: original.operationId,
			reason: "Customer exchanged size",
			session,
		});

		expect(reversal.status).toBe("voided");
		expect(reversal.reversalOf).toBe(original.operationId);
		expect(reversal.total).toBe(-1500000);
		expect(reversal.lines[0].quantity).toBe(-3);

		// Original marked voided
		const fetchedOriginal = await storage.getSale(original.operationId);
		expect(fetchedOriginal?.status).toBe("voided");

		// Stock allocation restored
		alloc = await storage.getAllocation("prod_jersey");
		expect(alloc?.soldQuantity).toBe(0);
		expect(alloc?.availableQuantity).toBe(10);
	});
});
