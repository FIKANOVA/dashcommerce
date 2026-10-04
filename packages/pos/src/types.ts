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

/**
 * Product & line item classifications supported across all business types.
 */
export type PosItemType =
	| "merchandise"  // Physical goods with inventory (retail, apparel, books)
	| "hospitality"  // Food & Beverage, bar, cafe, restaurant items
	| "ticket"       // Event admissions, gate passes, wristbands
	| "membership"   // Subscriptions, member dues, annual registrations
	| "service"      // Appointments, repairs, pitch hire, coaching
	| "custom";      // On-the-fly custom price line items

/**
 * Item modifiers/add-ons for hospitality, customization, and service businesses
 */
export interface PosItemModifier {
	id: string;
	name: string;
	price: number; // minor units
}

export interface PosLineItem {
	productId: string;
	variantId?: string;
	title: string;
	sku?: string;
	itemType?: PosItemType;
	notes?: string; // Special instructions, customer name, table info
	modifiers?: PosItemModifier[];
	quantity: number;
	unitPrice: number; // minor units
	tax: number; // minor units
	lineSubtotal: number; // minor units (quantity * unitPrice)
}

/**
 * Operating mode and profile for any business type running DashCommerce POS.
 */
export type PosBusinessMode =
	| "retail"           // Physical goods, barcode-driven, stock allocations
	| "hospitality"      // Food & Beverage, bars, cafes, quick service, tabs
	| "ticketing"        // Event gates, admissions, box office, pass issuing
	| "services"         // Professional services, rentals, custom booking
	| "multi_department"; // Combined operations (e.g. club with bar, gate, & shop)

export interface PosBusinessProfile {
	mode: PosBusinessMode;
	storeName: string;
	locationId: string;
	taxNumber?: string;
	currency: string;
	supportedTenders: PosTenderType[];
	allowCustomItems: boolean;
	allowSplitTenders: boolean;
	features: {
		barcodeScanning?: boolean;
		stockAllocation?: boolean;
		kitchenPrinting?: boolean;
		tableTracking?: boolean;
		ticketValidation?: boolean;
		memberLookup?: boolean;
	};
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
