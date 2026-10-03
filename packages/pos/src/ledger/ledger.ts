import { checkOfflineSaleEligibility } from "../allocation/allocation-guard";
import { validatePosTenders } from "../tenders/tender";
import type {
	PosLineItem,
	PosOperatorSession,
	PosSaleRecord,
	PosSaleStatus,
	PosTenderLine,
} from "../types";
import { TabLockManager } from "./fencing";
import type { PosStorageAdapter } from "./storage";

export interface CreateSaleInput {
	merchantId: string;
	locationId: string;
	deviceId: string;
	catalogueVersion: string;
	lines: PosLineItem[];
	tenders: PosTenderLine[];
	currency: string;
	session: PosOperatorSession;
	isOnline?: boolean;
	allowDraft?: boolean;
}

export interface CreateReversalInput {
	originalOperationId: string;
	reason: string;
	session: PosOperatorSession;
}

export class PosLedger {
	private readonly storage: PosStorageAdapter;
	private readonly fencing: TabLockManager;

	constructor(options: {
		storage: PosStorageAdapter;
		deviceId: string;
		tabId?: string;
	}) {
		this.storage = options.storage;
		this.fencing = new TabLockManager({
			deviceId: options.deviceId,
			tabId: options.tabId,
		});
	}

	getLockManager(): TabLockManager {
		return this.fencing;
	}

	async createSale(input: CreateSaleInput): Promise<PosSaleRecord> {
		// 1. Assert multi-tab write lock lease
		this.fencing.assertCanWrite();

		// 2. Compute sale total and tax
		let total = 0;
		let taxTotal = 0;
		for (const line of input.lines) {
			total += line.lineSubtotal;
			taxTotal += line.tax;
		}

		// 3. Validate tenders
		const tenderResult = validatePosTenders({
			saleTotal: total,
			currency: input.currency,
			tenders: input.tenders,
			isOnline: input.isOnline ?? false,
			allowDraft: input.allowDraft ?? true,
		});

		if (!tenderResult.valid) {
			throw new Error(`Invalid POS sale tenders: ${tenderResult.errors.join("; ")}`);
		}

		// 4. Verify offline stock allocation and operator authorization
		const eligibility = await checkOfflineSaleEligibility({
			lines: input.lines,
			session: input.session,
			getAllocation: (prodId, varId) =>
				this.storage.getAllocation(prodId, varId),
		});

		let status: PosSaleStatus = tenderResult.status;
		if (!eligibility.allowed) {
			if (input.allowDraft) {
				status = "draft";
			} else {
				throw new Error(`POS sale blocked: ${eligibility.reason}`);
			}
		}

		// 5. Generate monotonic device sequence and UUID
		const deviceSequence = await this.storage.getNextSequence(input.deviceId);
		const operationId =
			typeof crypto.randomUUID === "function"
				? crypto.randomUUID()
				: `op_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

		// If cash tender produced change, mark changeGiven on the cash tender line
		const tenders: PosTenderLine[] = input.tenders.map((t) => {
			if (t.type === "cash" && tenderResult.changeDue > 0) {
				return { ...t, changeGiven: tenderResult.changeDue };
			}
			return { ...t };
		});

		const saleRecord: PosSaleRecord = {
			operationId,
			deviceSequence,
			merchantId: input.merchantId,
			locationId: input.locationId,
			deviceId: input.deviceId,
			operatorId: input.session.operatorId,
			schemaVersion: 1,
			catalogueVersion: input.catalogueVersion,
			lines: input.lines,
			tenders,
			total,
			taxTotal,
			currency: input.currency.toUpperCase(),
			localTimestamp: new Date().toISOString(),
			status,
			syncStatus: "pending",
		};

		// 6. Atomically persist sale and update local stock allocation
		await this.storage.saveSale(saleRecord);

		if (status === "completed") {
			for (const line of input.lines) {
				const alloc = await this.storage.getAllocation(
					line.productId,
					line.variantId,
				);
				if (alloc) {
					alloc.soldQuantity += line.quantity;
					alloc.availableQuantity = Math.max(
						0,
						alloc.allocatedQuantity - alloc.soldQuantity,
					);
					await this.storage.saveAllocation(alloc);
				}
			}
		}

		return saleRecord;
	}

	async createReversal(input: CreateReversalInput): Promise<PosSaleRecord> {
		this.fencing.assertCanWrite();

		const original = await this.storage.getSale(input.originalOperationId);
		if (!original) {
			throw new Error(
				`Original sale not found for reversal: ${input.originalOperationId}`,
			);
		}

		if (original.status === "voided") {
			throw new Error("Sale is already reversed/voided");
		}

		const deviceSequence = await this.storage.getNextSequence(
			original.deviceId,
		);
		const operationId =
			typeof crypto.randomUUID === "function"
				? crypto.randomUUID()
				: `rev_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

		// Append-only reversal: negative line totals and inverted tenders
		const reversalRecord: PosSaleRecord = {
			operationId,
			deviceSequence,
			merchantId: original.merchantId,
			locationId: original.locationId,
			deviceId: original.deviceId,
			operatorId: input.session.operatorId,
			schemaVersion: 1,
			catalogueVersion: original.catalogueVersion,
			lines: original.lines.map((l) => ({
				...l,
				quantity: -l.quantity,
				lineSubtotal: -l.lineSubtotal,
				tax: -l.tax,
			})),
			tenders: original.tenders.map((t) => ({
				...t,
				amount: -t.amount,
				changeGiven: t.changeGiven ? -t.changeGiven : undefined,
			})),
			total: -original.total,
			taxTotal: -original.taxTotal,
			currency: original.currency,
			localTimestamp: new Date().toISOString(),
			status: "voided",
			syncStatus: "pending",
			reversalOf: original.operationId,
			reversalReason: input.reason,
		};

		// Mark original sale voided
		original.status = "voided";
		await this.storage.saveSale(original);

		// Save reversal record
		await this.storage.saveSale(reversalRecord);

		// Restore local allocated quantities
		for (const line of original.lines) {
			const alloc = await this.storage.getAllocation(
				line.productId,
				line.variantId,
			);
			if (alloc) {
				alloc.soldQuantity = Math.max(0, alloc.soldQuantity - line.quantity);
				alloc.availableQuantity = alloc.allocatedQuantity - alloc.soldQuantity;
				await this.storage.saveAllocation(alloc);
			}
		}

		return reversalRecord;
	}
}
