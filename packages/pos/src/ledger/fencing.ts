/**
 * Multi-tab writer fencing for local POS ledger.
 *
 * Ensures only a single active tab/window can commit sales and advance the
 * local device sequence. Secondary tabs throw TabFencingError rather than
 * creating interleaved sequence conflicts.
 */

export class TabFencingError extends Error {
	constructor(message = "Another tab holds the active POS write lease") {
		super(message);
		this.name = "TabFencingError";
	}
}

export interface TabLease {
	leaseHolderId: string;
	acquiredAt: number;
	expiresAt: number;
}

export class TabLockManager {
	private static readonly activeLeases = new Map<
		string,
		{ holderId: string; expiresAt: number }
	>();

	static resetAll(): void {
		TabLockManager.activeLeases.clear();
	}

	private readonly lockKey: string;
	private readonly tabId: string;
	private readonly leaseTtlMs: number;

	constructor(options: {
		deviceId: string;
		tabId?: string;
		leaseTtlMs?: number;
	}) {
		this.lockKey = `pos_writer_lease:${options.deviceId}`;
		this.tabId =
			options.tabId || `tab_${Math.random().toString(36).slice(2, 9)}`;
		this.leaseTtlMs = options.leaseTtlMs || 5000;
	}

	getTabId(): string {
		return this.tabId;
	}

	isLeader(): boolean {
		const now = Date.now();
		const current = TabLockManager.activeLeases.get(this.lockKey);
		return current?.holderId === this.tabId && now < current.expiresAt;
	}

	acquireLease(): boolean {
		const now = Date.now();
		const current = TabLockManager.activeLeases.get(this.lockKey);
		// If current lease is expired or already held by us
		if (!current || now >= current.expiresAt || current.holderId === this.tabId) {
			TabLockManager.activeLeases.set(this.lockKey, {
				holderId: this.tabId,
				expiresAt: now + this.leaseTtlMs,
			});
			return true;
		}
		return false;
	}

	renewLease(): boolean {
		const current = TabLockManager.activeLeases.get(this.lockKey);
		if (current?.holderId === this.tabId) {
			current.expiresAt = Date.now() + this.leaseTtlMs;
			return true;
		}
		return false;
	}

	releaseLease(): void {
		const current = TabLockManager.activeLeases.get(this.lockKey);
		if (current?.holderId === this.tabId) {
			TabLockManager.activeLeases.delete(this.lockKey);
		}
	}

	assertCanWrite(): void {
		if (!this.isLeader() && !this.acquireLease()) {
			const current = TabLockManager.activeLeases.get(this.lockKey);
			throw new TabFencingError(
				`Tab ${this.tabId} denied write lease: held by ${current?.holderId}`,
			);
		}
	}
}
