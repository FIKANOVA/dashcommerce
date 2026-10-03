import type { PosReceipt } from "../types";

export interface DrawerKickOptions {
	pin?: 0 | 1;
	onTimeMs?: number;
	offTimeMs?: number;
}

export class EscPosEncoder {
	private buffer: number[] = [];

	init(): this {
		this.buffer.push(0x1b, 0x40); // ESC @
		return this;
	}

	align(alignment: "left" | "center" | "right"): this {
		const val = alignment === "center" ? 1 : alignment === "right" ? 2 : 0;
		this.buffer.push(0x1b, 0x61, val); // ESC a n
		return this;
	}

	bold(enable: boolean): this {
		this.buffer.push(0x1b, 0x45, enable ? 1 : 0); // ESC E n
		return this;
	}

	line(text = ""): this {
		const enc = new TextEncoder();
		const bytes = enc.encode(text);
		this.buffer.push(...bytes, 0x0a); // text + LF
		return this;
	}

	feed(count = 1): this {
		for (let i = 0; i < count; i++) {
			this.buffer.push(0x0a);
		}
		return this;
	}

	cut(): this {
		this.buffer.push(0x1d, 0x56, 0x42, 0x00); // GS V 66 0 (partial/full cut)
		return this;
	}

	drawerKick(options?: DrawerKickOptions): this {
		const pin = options?.pin ?? 0;
		const on = Math.floor((options?.onTimeMs ?? 50) / 2);
		const off = Math.floor((options?.offTimeMs ?? 500) / 2);
		this.buffer.push(0x1b, 0x70, pin, on, off); // ESC p pin on off
		return this;
	}

	encodeReceipt(receipt: PosReceipt): Uint8Array {
		this.init();
		this.align("center");
		this.bold(true);
		this.line(receipt.storeName);
		this.bold(false);

		if (receipt.address) {
			this.line(receipt.address);
		}
		if (receipt.taxNumber) {
			this.line(`PIN: ${receipt.taxNumber}`);
		}
		if (receipt.reprint) {
			this.bold(true);
			this.line("*** DUPLICATE / REPRINT ***");
			this.bold(false);
		}

		this.feed(1);
		this.align("left");
		this.line(`Receipt: ${receipt.sale.operationId.slice(0, 8).toUpperCase()}`);
		this.line(`Date: ${new Date(receipt.sale.localTimestamp).toLocaleString()}`);
		this.line(`Operator: ${receipt.sale.operatorId}`);
		this.line(`Device Seq: #${receipt.sale.deviceSequence}`);
		this.line("--------------------------------");

		for (const item of receipt.sale.lines) {
			const itemTotal = (item.lineSubtotal / 100).toFixed(2);
			const unit = (item.unitPrice / 100).toFixed(2);
			this.line(`${item.title}`);
			this.line(`  ${item.quantity} x ${unit} ${receipt.sale.currency} = ${itemTotal}`);
		}

		this.line("--------------------------------");
		const totalFormatted = (receipt.sale.total / 100).toFixed(2);
		this.bold(true);
		this.line(`TOTAL: ${receipt.sale.currency} ${totalFormatted}`);
		this.bold(false);

		for (const tender of receipt.sale.tenders) {
			const tendered = (tender.amount / 100).toFixed(2);
			this.line(`Tender (${tender.type}): ${tender.currency} ${tendered}`);
			if (tender.changeGiven && tender.changeGiven > 0) {
				const change = (tender.changeGiven / 100).toFixed(2);
				this.line(`Change: ${tender.currency} ${change}`);
			}
		}

		if (receipt.footerText) {
			this.feed(1);
			this.align("center");
			this.line(receipt.footerText);
		}

		this.feed(3);
		this.cut();
		return new Uint8Array(this.buffer);
	}

	getBytes(): Uint8Array {
		return new Uint8Array(this.buffer);
	}
}
