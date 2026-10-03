import type { PosReceipt } from "../types";
import { type DrawerKickOptions, EscPosEncoder } from "./escpos";

export interface PrinterTransport {
	send(bytes: Uint8Array): Promise<void>;
	isConnected(): boolean;
}

export class SimulatedPrinterTransport implements PrinterTransport {
	public sentBuffers: Uint8Array[] = [];
	public connected = true;

	async send(bytes: Uint8Array): Promise<void> {
		if (!this.connected) {
			throw new Error("Printer transport disconnected");
		}
		this.sentBuffers.push(new Uint8Array(bytes));
	}

	isConnected(): boolean {
		return this.connected;
	}

	clear(): void {
		this.sentBuffers = [];
	}
}

export class PosPrinterAdapter {
	private readonly transport: PrinterTransport;
	private readonly drawerOptions: DrawerKickOptions;

	constructor(
		transport: PrinterTransport,
		options?: { drawerOptions?: DrawerKickOptions },
	) {
		this.transport = transport;
		this.drawerOptions = options?.drawerOptions || {
			pin: 0,
			onTimeMs: 50,
			offTimeMs: 500,
		};
	}

	async printReceipt(
		receipt: PosReceipt,
		options?: { kickDrawer?: boolean },
	): Promise<{ success: boolean; bytesSent: number; error?: string }> {
		if (!this.transport.isConnected()) {
			return {
				success: false,
				bytesSent: 0,
				error: "Printer is not connected or permission was denied",
			};
		}

		try {
			const encoder = new EscPosEncoder();
			const receiptBytes = encoder.encodeReceipt(receipt);

			// Safety rule: Never automatically kick drawer on duplicate/reprint!
			if (options?.kickDrawer && !receipt.reprint) {
				const drawerEncoder = new EscPosEncoder();
				drawerEncoder.drawerKick(this.drawerOptions);
				const drawerBytes = drawerEncoder.getBytes();

				const combined = new Uint8Array(
					receiptBytes.length + drawerBytes.length,
				);
				combined.set(receiptBytes, 0);
				combined.set(drawerBytes, receiptBytes.length);

				await this.transport.send(combined);
				return { success: true, bytesSent: combined.length };
			}

			await this.transport.send(receiptBytes);
			return { success: true, bytesSent: receiptBytes.length };
		} catch (err: any) {
			return {
				success: false,
				bytesSent: 0,
				error: err.message || "Failed to transmit print job",
			};
		}
	}

	async openCashDrawer(): Promise<{ success: boolean; error?: string }> {
		if (!this.transport.isConnected()) {
			return {
				success: false,
				error: "Printer is not connected (cash drawer requires printer RJ-11 kick)",
			};
		}

		try {
			const encoder = new EscPosEncoder();
			encoder.drawerKick(this.drawerOptions);
			await this.transport.send(encoder.getBytes());
			return { success: true };
		} catch (err: any) {
			return {
				success: false,
				error: err.message || "Failed to trigger drawer kick command",
			};
		}
	}
}
