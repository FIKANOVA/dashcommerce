import { describe, expect, it } from "bun:test";
import { MemoryPosStorageAdapter } from "../src/ledger/storage";
import { PosSynchronizer, type SyncServerClient } from "../src/sync/synchronizer";
import type { PosSaleRecord } from "../src/types";

describe("POS Synchronizer & Conflict Resolution", () => {
	it("synchronizes pending sales and updates status to synced", async () => {
		const storage = new MemoryPosStorageAdapter();

		const sale: PosSaleRecord = {
			operationId: "op_sync_001",
			deviceSequence: 1,
			merchantId: "merch_nondies",
			locationId: "loc_jamhuri",
			deviceId: "kiosk_01",
			operatorId: "op_1",
			schemaVersion: 1,
			catalogueVersion: "v1",
			lines: [],
			tenders: [],
			total: 50000,
			taxTotal: 0,
			currency: "KES",
			localTimestamp: new Date().toISOString(),
			status: "completed",
			syncStatus: "pending",
		};
		await storage.saveSale(sale);

		const serverClient: SyncServerClient = {
			syncSale: async (s) => ({
				success: true,
				serverOrderId: `srv_ord_${s.operationId}`,
			}),
		};

		const synchronizer = new PosSynchronizer(storage, serverClient);
		const result = await synchronizer.syncPendingSales();

		expect(result.syncedCount).toBe(1);
		expect(result.conflictCount).toBe(0);

		const updated = await storage.getSale("op_sync_001");
		expect(updated?.syncStatus).toBe("synced");
		expect(updated?.serverOrderId).toBe("srv_ord_op_sync_001");
	});

	it("detects server conflicts and marks sales with conflict status without data loss", async () => {
		const storage = new MemoryPosStorageAdapter();

		const sale: PosSaleRecord = {
			operationId: "op_sync_conflict",
			deviceSequence: 2,
			merchantId: "merch_nondies",
			locationId: "loc_jamhuri",
			deviceId: "kiosk_01",
			operatorId: "op_1",
			schemaVersion: 1,
			catalogueVersion: "v1",
			lines: [],
			tenders: [],
			total: 50000,
			taxTotal: 0,
			currency: "KES",
			localTimestamp: new Date().toISOString(),
			status: "completed",
			syncStatus: "pending",
		};
		await storage.saveSale(sale);

		const serverClient: SyncServerClient = {
			syncSale: async () => ({
				success: false,
				conflict: true,
				conflictReason: "Device sequence gap detected: expected 1 but got 2",
			}),
		};

		const synchronizer = new PosSynchronizer(storage, serverClient);
		const result = await synchronizer.syncPendingSales();

		expect(result.syncedCount).toBe(0);
		expect(result.conflictCount).toBe(1);
		expect(result.conflicts[0].reason).toContain("Device sequence gap detected");

		const updated = await storage.getSale("op_sync_conflict");
		expect(updated?.syncStatus).toBe("conflict");
		expect(updated?.conflictDetails).toContain("Device sequence gap detected");
	});
});
