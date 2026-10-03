import type { PosStorageAdapter } from "../ledger/storage";
import type { PosSaleRecord } from "../types";

export interface SyncServerClient {
	syncSale(sale: PosSaleRecord): Promise<{
		success: boolean;
		serverOrderId?: string;
		conflict?: boolean;
		conflictReason?: string;
	}>;
}

export interface SyncBatchResult {
	syncedCount: number;
	conflictCount: number;
	failedCount: number;
	conflicts: Array<{ operationId: string; reason: string }>;
}

export class PosSynchronizer {
	private readonly storage: PosStorageAdapter;
	private readonly serverClient: SyncServerClient;
	private syncing = false;

	constructor(storage: PosStorageAdapter, serverClient: SyncServerClient) {
		this.storage = storage;
		this.serverClient = serverClient;
	}

	async syncPendingSales(): Promise<SyncBatchResult> {
		if (this.syncing) {
			return { syncedCount: 0, conflictCount: 0, failedCount: 0, conflicts: [] };
		}

		this.syncing = true;
		const result: SyncBatchResult = {
			syncedCount: 0,
			conflictCount: 0,
			failedCount: 0,
			conflicts: [],
		};

		try {
			const pending = await this.storage.listSales({ syncStatus: "pending" });

			for (const sale of pending) {
				try {
					const res = await this.serverClient.syncSale(sale);

					if (res.conflict) {
						result.conflictCount++;
						result.conflicts.push({
							operationId: sale.operationId,
							reason: res.conflictReason || "Server reported conflict",
						});
						await this.storage.updateSyncStatus(
							sale.operationId,
							"conflict",
							undefined,
							res.conflictReason,
						);
					} else if (res.success) {
						result.syncedCount++;
						await this.storage.updateSyncStatus(
							sale.operationId,
							"synced",
							res.serverOrderId,
						);
					} else {
						result.failedCount++;
					}
				} catch {
					result.failedCount++;
					// Network or temporary server failure; remains pending for next retry
				}
			}
		} finally {
			this.syncing = false;
		}

		return result;
	}
}
