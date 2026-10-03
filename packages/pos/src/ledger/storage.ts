import type {
	PosSaleRecord,
	PosSaleStatus,
	PosStockAllocation,
	PosSyncStatus,
} from "../types";

export interface PosStorageAdapter {
	saveSale(sale: PosSaleRecord): Promise<void>;
	getSale(operationId: string): Promise<PosSaleRecord | null>;
	listSales(filter?: {
		status?: PosSaleStatus;
		syncStatus?: PosSyncStatus;
	}): Promise<PosSaleRecord[]>;
	updateSyncStatus(
		operationId: string,
		syncStatus: PosSyncStatus,
		serverOrderId?: string,
		conflictDetails?: string,
	): Promise<void>;
	getNextSequence(deviceId: string): Promise<number>;
	getAllocation(
		productId: string,
		variantId?: string,
	): Promise<PosStockAllocation | null>;
	saveAllocation(allocation: PosStockAllocation): Promise<void>;
	listAllocations(): Promise<PosStockAllocation[]>;
}

/**
 * In-memory POS storage adapter for tests and non-browser edge runtimes.
 */
export class MemoryPosStorageAdapter implements PosStorageAdapter {
	private readonly sales = new Map<string, PosSaleRecord>();
	private readonly allocations = new Map<string, PosStockAllocation>();
	private readonly sequences = new Map<string, number>();

	private allocKey(productId: string, variantId?: string): string {
		return variantId ? `${productId}:${variantId}` : productId;
	}

	async saveSale(sale: PosSaleRecord): Promise<void> {
		this.sales.set(sale.operationId, JSON.parse(JSON.stringify(sale)));
		const currentSeq = this.sequences.get(sale.deviceId) ?? 0;
		if (sale.deviceSequence > currentSeq) {
			this.sequences.set(sale.deviceId, sale.deviceSequence);
		}
	}

	async getSale(operationId: string): Promise<PosSaleRecord | null> {
		const s = this.sales.get(operationId);
		return s ? JSON.parse(JSON.stringify(s)) : null;
	}

	async listSales(filter?: {
		status?: PosSaleStatus;
		syncStatus?: PosSyncStatus;
	}): Promise<PosSaleRecord[]> {
		let list = Array.from(this.sales.values());
		if (filter?.status) {
			list = list.filter((s) => s.status === filter.status);
		}
		if (filter?.syncStatus) {
			list = list.filter((s) => s.syncStatus === filter.syncStatus);
		}
		return list.sort((a, b) => a.deviceSequence - b.deviceSequence);
	}

	async updateSyncStatus(
		operationId: string,
		syncStatus: PosSyncStatus,
		serverOrderId?: string,
		conflictDetails?: string,
	): Promise<void> {
		const sale = this.sales.get(operationId);
		if (sale) {
			sale.syncStatus = syncStatus;
			if (serverOrderId) sale.serverOrderId = serverOrderId;
			if (conflictDetails) sale.conflictDetails = conflictDetails;
			if (syncStatus === "synced") sale.syncedAt = new Date().toISOString();
		}
	}

	async getNextSequence(deviceId: string): Promise<number> {
		const current = this.sequences.get(deviceId) ?? 0;
		const next = current + 1;
		this.sequences.set(deviceId, next);
		return next;
	}

	async getAllocation(
		productId: string,
		variantId?: string,
	): Promise<PosStockAllocation | null> {
		const a = this.allocations.get(this.allocKey(productId, variantId));
		return a ? JSON.parse(JSON.stringify(a)) : null;
	}

	async saveAllocation(allocation: PosStockAllocation): Promise<void> {
		const key = this.allocKey(allocation.productId, allocation.variantId);
		this.allocations.set(key, JSON.parse(JSON.stringify(allocation)));
	}

	async listAllocations(): Promise<PosStockAllocation[]> {
		return Array.from(this.allocations.values());
	}
}
