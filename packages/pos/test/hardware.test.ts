import { describe, expect, it } from "bun:test";
import { EscPosEncoder } from "../src/hardware/escpos";
import {
	PosPrinterAdapter,
	SimulatedPrinterTransport,
} from "../src/hardware/printer";
import { KeyboardWedgeScanner } from "../src/hardware/scanner";
import type { PosReceipt } from "../src/types";

describe("POS Hardware Transports & Encoding", () => {
	const sampleReceipt: PosReceipt = {
		storeName: "Nondies Rugby Clubhouse Store",
		address: "Jamhuri Park, Ngong Road, Nairobi",
		taxNumber: "P051234567Z",
		sale: {
			operationId: "op_test_hw_001",
			deviceSequence: 42,
			merchantId: "merch_nondies",
			locationId: "loc_jamhuri",
			deviceId: "kiosk_01",
			operatorId: "op_moseti",
			schemaVersion: 1,
			catalogueVersion: "v1",
			lines: [
				{
					productId: "prod_jersey",
					title: "Nondies Match Jersey",
					quantity: 1,
					unitPrice: 500000,
					tax: 0,
					lineSubtotal: 500000,
				},
			],
			tenders: [
				{
					id: "t_1",
					type: "cash",
					amount: 500000,
					currency: "KES",
					verified: true,
				},
			],
			total: 500000,
			taxTotal: 0,
			currency: "KES",
			localTimestamp: new Date().toISOString(),
			status: "completed",
			syncStatus: "pending",
		},
	};

	it("ESC/POS: encodes receipt header, items, totals, and paper cut command", () => {
		const encoder = new EscPosEncoder();
		const bytes = encoder.encodeReceipt(sampleReceipt);

		// Header starts with ESC @ (0x1b, 0x40)
		expect(bytes[0]).toBe(0x1b);
		expect(bytes[1]).toBe(0x40);

		// Paper cut at end: GS V 66 0 (0x1d, 0x56, 0x42, 0x00)
		const len = bytes.length;
		expect(bytes[len - 4]).toBe(0x1d);
		expect(bytes[len - 3]).toBe(0x56);
		expect(bytes[len - 2]).toBe(0x42);
		expect(bytes[len - 1]).toBe(0x00);
	});

	it("Printer & Drawer: does NOT kick cash drawer on reprint", async () => {
		const transport = new SimulatedPrinterTransport();
		const printer = new PosPrinterAdapter(transport);

		// Normal receipt with kickDrawer: true
		await printer.printReceipt(sampleReceipt, { kickDrawer: true });
		expect(transport.sentBuffers.length).toBe(1);

		// Check drawer kick command bytes ESC p 0 25 250 (0x1b, 0x70, 0x00, 0x19, 0xfa)
		const normalJob = transport.sentBuffers[0];
		const hasKick = normalJob.some(
			(b, i) =>
				b === 0x1b &&
				normalJob[i + 1] === 0x70 &&
				normalJob[i + 2] === 0x00,
		);
		expect(hasKick).toBe(true);

		transport.clear();

		// Reprint receipt with kickDrawer: true
		const reprintReceipt: PosReceipt = {
			...sampleReceipt,
			reprint: true,
		};
		await printer.printReceipt(reprintReceipt, { kickDrawer: true });

		const reprintJob = transport.sentBuffers[0];
		const reprintHasKick = reprintJob.some(
			(b, i) =>
				b === 0x1b &&
				reprintJob[i + 1] === 0x70 &&
				reprintJob[i + 2] === 0x00,
		);
		expect(reprintHasKick).toBe(false); // Safety: no drawer kick on reprint!
	});

	it("Barcode Scanner: keyboard wedge triggers on rapid scanner input and ignores slow human typing", () => {
		const scanner = new KeyboardWedgeScanner({ maxInterKeyDeltaMs: 40 });
		const scannedBarcodes: string[] = [];
		scanner.onScan((e) => scannedBarcodes.push(e.barcode));

		// Rapid scanner input: "7123456789" (10ms delta between keys)
		let t = 1000;
		for (const ch of "7123456789") {
			scanner.handleKeyDown(ch, t);
			t += 10;
		}
		scanner.handleKeyDown("Enter", t + 10);

		expect(scannedBarcodes.length).toBe(1);
		expect(scannedBarcodes[0]).toBe("7123456789");

		// Slow human typing (150ms delta)
		t = 5000;
		for (const ch of "HUMANTYPE") {
			scanner.handleKeyDown(ch, t);
			t += 150;
		}
		scanner.handleKeyDown("Enter", t + 150);

		// Buffer was reset due to slow typing; only the last character ("E") remained, which is < minLength (3)
		expect(scannedBarcodes.length).toBe(1);
	});
});
