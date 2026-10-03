/**
 * Core type definitions for the offline-capable DashCommerce POS package.
 */

export type PosTenderType =
	| "cash"
	| "mpesa_stk"
	| "mpesa_qr"
	| "card_terminal";

export interface PosTenderLine {
	id: string;
	type: PosTenderType;
	amount: number; // minor units
	currency: string;
	changeGiven?: number; // minor units (cash only)
	verified: boolean;
	externalReference?: string;
	metadata?: Record<string, unknown>;
}

export interface PosLineItem {
	productId: string;
	variantId?: string;
	title: string;
	sku?: string;
	quantity: number;
	unitPrice: number; // minor units
	tax: number; // minor units
	lineSubtotal: number; // minor units (quantity * unitPrice)
}

export type PosSaleStatus = "completed" | "draft" | "voided";
export type PosSyncStatus = "pending" | "synced" | "conflict";

export interface PosSaleRecord {
	/** Unique idempotent client operation UUID */
	operationId: string;
	/** Monotonically increasing sequence number per device */
	deviceSequence: number;
	merchantId: string;
	locationId: string;
	deviceId: string;
	operatorId: string;
	schemaVersion: number;
	catalogueVersion: string;
	lines: PosLineItem[];
	tenders: PosTenderLine[];
	total: number; // minor units
	taxTotal: number; // minor units
	currency: string;
	localTimestamp: string;
	status: PosSaleStatus;
	syncStatus: PosSyncStatus;
	reversalOf?: string; // UUID of original sale if this is a reversal
	reversalReason?: string;
	serverOrderId?: string;
	syncedAt?: string;
	conflictDetails?: string;
}

export interface PosStockAllocation {
	productId: string;
	variantId?: string;
	deviceId: string;
	allocatedQuantity: number;
	soldQuantity: number;
	availableQuantity: number;
	expiresAt: string;
}

export interface PosOperatorSession {
	operatorId: string;
	operatorName: string;
	deviceId: string;
	authenticatedAt: string;
	expiresAt: string;
	permissions: string[];
}

export interface PosReceipt {
	sale: PosSaleRecord;
	storeName: string;
	address?: string;
	taxNumber?: string;
	footerText?: string;
	reprint?: boolean;
}
