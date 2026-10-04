# Universal Point of Sale (POS) Architecture in DashCommerce

**Package:** `@dashcommerce/pos`  
**Purpose:** Universal, multi-vertical, offline-first Point of Sale engine for EmDash & DashCommerce  
**Audience:** Platform Architects, Extension Developers, Store Operators  

---

## 1. Executive Summary: POS is Not Limited to Merchandise

While initial matchday examples focused on sports merchandise (jerseys, caps), **DashCommerce POS is a universal Point of Sale engine designed to serve any business model supported by the DashCommerce core commerce platform**, including:

1. **Retail & Physical Goods**: Apparel, electronics, groceries, supermarkets, bookstores, gift shops.
2. **Food & Beverage / Hospitality**: Cafes, restaurants, bars, sports clubhouse canteens, food trucks.
3. **Ticketing, Admissions & Box Office**: Stadium gates, concerts, festivals, conferences, cinema seats.
4. **Memberships & Subscriptions**: Sports clubs, gyms, associations, co-working spaces, annual passes.
5. **Services, Rentals & Custom Charges**: Pitch hire, repairs, salon services, custom quote walk-ins.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           DashCommerce POS Engine                           │
│                      (@dashcommerce/pos — Universal)                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  Supported Verticals:                                                       │
│   [Retail & Apparel]       [Food & Beverage / Bar]    [Gate & Ticketing]    │
│   [Memberships / Subs]     [Services & Rentals]       [Custom Quick Sales]  │
├─────────────────────────────────────────────────────────────────────────────┤
│  Core Architectural Capabilities:                                           │
│   • Local-First Ledger (IndexedDB: works 100% offline during outages)       │
│   • Multi-Tab Concurrency Fencing (Web Locks API / leader election)         │
│   • Multi-Tender Engine (Cash + Change, Card PDQ, Mobile Money STK, Split) │
│   • Hardware Abstraction (WebUSB/Serial ESC/POS, Cash Drawer, Barcode Wedge)│
│   • Conflict-Free Reconnection Sync & Audit Trails (X-Report & Z-Report)    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Multi-Vertical Business Modes (`PosBusinessMode`)

A POS register can be configured for a specific vertical or operated in a combined multi-department mode:

```typescript
export type PosBusinessMode =
  | "retail"           // Barcode scanning, SKU inventory, variant matrices (size/color)
  | "hospitality"      // Fast-tap menu grids, item modifiers, tables/tabs, kitchen tickets
  | "ticketing"        // Gate admission, QR validation, attendee names, pass printing
  | "services"         // Time-based booking, custom line items, technician notes
  | "multi_department"; // Combined operations (e.g. stadium shop + clubhouse bar + gate)
```

### 2.1 Retail & Physical Goods
- **Capabilities:** Barcode scanning via USB/Bluetooth keyboard wedge, SKU lookup, physical stock decrements from local allocations, variant pickers (e.g. Size: S/M/L/XL, Color: Red/White).
- **Offline Behavior:** Bounded by local device inventory allocation to prevent overselling across multiple checkout lanes.

### 2.2 Food & Beverage / Hospitality (Bars & Canteens)
- **Capabilities:** Quick-tap category grids, item modifiers (`PosItemModifier`: e.g. "Cold/Room Temp", "Extra Shot", "With Chips"), table/tab assignment, kitchen/bar prep ticket printing.
- **Tender:** High-velocity cash and instant mobile money prompts with rapid receipt issue.

### 2.3 Event Ticketing & Box Office (Gate Admissions)
- **Capabilities:** Fast admission pass selection (General Admission, VIP Stand, Student Gate Ticket), automated unique ticket code generation, digital QR verification, wristband/ticket receipt printing.
- **Security:** Verified gate check-in preventing duplicate ticket entry (exactly-once scan guarantee).

### 2.4 Memberships & Subscriptions
- **Capabilities:** Member ID lookup, annual subscription renewals, player registration fees, social member dues, issuing digital or physical member passes.
- **Core Link:** Syncs with DashCommerce subscription entities (`ctx.storage.subscriptions`).

### 2.5 Services, Rentals & Quick Custom Sales
- **Capabilities:** Allows operators to enter a custom title and price on the fly (e.g. "Pitch Rental - 1 Hour: KES 3,500" or "Lost Key Replacement: KES 500") without needing a pre-created catalog product.

---

## 3. Data Model Architecture

The `PosLineItem` entity accommodates all business types:

```typescript
export type PosItemType =
  | "merchandise"  // Physical goods with inventory
  | "hospitality"  // Food & Beverage, bar, cafe, restaurant items
  | "ticket"       // Event admissions, gate passes
  | "membership"   // Subscriptions, member dues, annual fees
  | "service"      // Appointments, rentals, coaching
  | "custom";      // On-the-fly custom price line items

export interface PosLineItem {
  productId: string;
  variantId?: string;
  title: string;
  sku?: string;
  itemType?: PosItemType;
  notes?: string;                 // e.g. Table 4, Customer Name, Kitchen note
  modifiers?: PosItemModifier[];  // Add-ons, toppings, options
  quantity: number;
  unitPrice: number;              // Minor units (integer)
  tax: number;                    // Minor units (integer)
  lineSubtotal: number;           // (quantity * unitPrice + modifiers)
}
```

---

## 4. Multi-Tender Engine (Universal Payment Flexibility)

Every business requires flexible tender handling at the point of sale:

1. **Cash Tender:**
   - Supports customer overpayment with exact change computation.
   - Triggers physical cash drawer kick via ESC/POS printer RJ-11/12 pulse (`ESC p 0 50 500`).
   - Generates duplicate-protected receipts.
2. **Card Terminal (PDQ):**
   - Operator enters the approval code / reference from an external banking terminal.
   - Enforces exact amount match (no change on electronic tenders).
3. **Mobile Money (M-Pesa STK Push / QR):**
   - Powered by the registered `PaymentProvider` (`@dashcommerce/palpluss`, `@dashcommerce/paystack`, or `@dashcommerce/pesapal`).
   - Customer phone is prompted directly; POS polls or listens for authenticated webhook completion.
4. **Split Tenders:**
   - Multiple tender lines on a single sale (e.g. KES 1,000 Cash + KES 2,500 M-Pesa).
   - The sale cannot be finalized until all electronic portions are cryptographically confirmed.
5. **Customer Accounts / Member Tabs:**
   - Allows charging to a house account with periodic settlement.

---

## 5. Offline Resilience & Shift Reconciliation

In developing markets and outdoor event venues (pitches, festivals, pop-ups), connectivity is unreliable. DashCommerce POS provides:

1. **Local-First Storage:** IndexedDB transactions store sales, lines, and tenders locally before any network dispatch.
2. **Multi-Tab Fencing:** Uses Web Locks API to ensure that if staff open multiple browser tabs on one POS terminal, only the active leader tab can record sales and advance sequence numbers.
3. **Shift Reconciliation (X & Z Reports):**
   - **X-Report:** Mid-shift snapshot of cash in drawer, card totals, mobile money totals, and category breakdown.
   - **Z-Report:** End-of-day closing report that locks the shift, records cash variance, resets the sequence counter, and flushes all offline records to the central store database upon reconnection.

---

## 6. Summary

DashCommerce POS is built to scale across **any commerce scenario**. Whether deployed at a stadium merchandise stall, a busy cafe/bar, an event entrance gate, or a retail boutique, the exact same `@dashcommerce/pos` package provides enterprise-grade, offline-first reliability.
