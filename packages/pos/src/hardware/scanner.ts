/**
 * Barcode scanner adapter supporting keyboard-wedge emulation and WebHID.
 */

export interface BarcodeScanEvent {
	barcode: string;
	timestamp: number;
}

export type ScanListener = (event: BarcodeScanEvent) => void;

export class KeyboardWedgeScanner {
	private buffer: string[] = [];
	private lastKeystrokeTime = 0;
	private readonly maxInterKeyDeltaMs: number;
	private readonly minBarcodeLength: number;
	private readonly listeners = new Set<ScanListener>();

	constructor(options?: {
		maxInterKeyDeltaMs?: number;
		minBarcodeLength?: number;
	}) {
		this.maxInterKeyDeltaMs = options?.maxInterKeyDeltaMs || 40;
		this.minBarcodeLength = options?.minBarcodeLength || 3;
	}

	onScan(listener: ScanListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Feed a keystroke into the detector.
	 *
	 * Returns true if the key completed a scanned barcode, false otherwise.
	 */
	handleKeyDown(key: string, now = Date.now()): boolean {
		if (key === "Enter") {
			const candidate = this.buffer.join("").trim();
			this.buffer = [];
			this.lastKeystrokeTime = 0;

			if (candidate.length >= this.minBarcodeLength) {
				const event: BarcodeScanEvent = {
					barcode: candidate,
					timestamp: now,
				};
				for (const listener of this.listeners) {
					listener(event);
				}
				return true;
			}
			return false;
		}

		if (key.length === 1) {
			const delta = now - this.lastKeystrokeTime;
			if (this.buffer.length > 0 && delta > this.maxInterKeyDeltaMs) {
				// Too slow for a scanner; reset buffer because human is typing
				this.buffer = [key];
			} else {
				this.buffer.push(key);
			}
			this.lastKeystrokeTime = now;
		}

		return false;
	}
}
