/**
 * A small QR code encoder for the Counter sale page: byte mode, error
 * correction level M, versions 1 to 10 (up to 213 bytes, plenty for a
 * payment link). Written for DashCommerce from the QR code standard
 * (ISO/IEC 18004), so the code is drawn by the page itself: no outside
 * service and no extra dependency.
 *
 * `encodeQr` returns the module grid; `qrPath` turns it into one SVG path.
 */

/** Data codewords per block, and error correction codewords per block, for level M. */
interface VersionSpec {
	/** Error correction codewords per block. */
	ec: number;
	/** Blocks as [how many, data codewords in each]. */
	blocks: Array<[number, number]>;
	/** Alignment pattern centres (rows and columns). */
	align: number[];
}

const VERSIONS: VersionSpec[] = [
	{ ec: 10, blocks: [[1, 16]], align: [] },
	{ ec: 16, blocks: [[1, 28]], align: [6, 18] },
	{ ec: 26, blocks: [[1, 44]], align: [6, 22] },
	{ ec: 18, blocks: [[2, 32]], align: [6, 26] },
	{ ec: 24, blocks: [[2, 43]], align: [6, 30] },
	{ ec: 16, blocks: [[4, 27]], align: [6, 34] },
	{ ec: 18, blocks: [[4, 31]], align: [6, 22, 38] },
	{ ec: 22, blocks: [[2, 38], [2, 39]], align: [6, 24, 42] },
	{ ec: 22, blocks: [[3, 36], [2, 37]], align: [6, 26, 46] },
	{ ec: 26, blocks: [[4, 43], [1, 44]], align: [6, 28, 50] },
];

export const QR_MAX_VERSION = VERSIONS.length;

/** Format bits for error correction level M. */
const ECC_M = 0b00;

export interface QrCode {
	version: number;
	/** Modules per side. */
	size: number;
	/** The chosen mask, 0 to 7. */
	mask: number;
	/** `modules[y][x]`: true is dark. */
	modules: boolean[][];
}

function specFor(version: number): VersionSpec {
	const spec = VERSIONS[version - 1];
	if (!spec) throw new Error(`QR version ${version} is not supported`);
	return spec;
}

/** Data codewords a version holds at level M. */
export function dataCodewords(version: number): number {
	return specFor(version).blocks.reduce((sum, [count, size]) => sum + count * size, 0);
}

/** Every codeword (data and error correction) a version holds, from its module count. */
export function totalCodewords(version: number): number {
	let modules = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const align = Math.floor(version / 7) + 2;
		modules -= (25 * align - 10) * align - 55;
		if (version >= 7) modules -= 36;
	}
	return Math.floor(modules / 8);
}

// ────────────────────────────────────────────────────────────────────────────
// Reed–Solomon over GF(256), polynomial x^8 + x^4 + x^3 + x^2 + 1
// ────────────────────────────────────────────────────────────────────────────

function gfMultiply(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

function rsDivisor(degree: number): number[] {
	const result = new Array<number>(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < degree; j++) {
			result[j] = gfMultiply(result[j] as number, root);
			if (j + 1 < degree) result[j] = (result[j] as number) ^ (result[j + 1] as number);
		}
		root = gfMultiply(root, 0x02);
	}
	return result;
}

/** The error correction codewords for one block of data. */
export function reedSolomon(data: readonly number[], degree: number): number[] {
	const divisor = rsDivisor(degree);
	const result = new Array<number>(degree).fill(0);
	for (const byte of data) {
		const factor = byte ^ (result.shift() as number);
		result.push(0);
		for (let i = 0; i < degree; i++) {
			result[i] = (result[i] as number) ^ gfMultiply(divisor[i] as number, factor);
		}
	}
	return result;
}

// ────────────────────────────────────────────────────────────────────────────
// Codewords
// ────────────────────────────────────────────────────────────────────────────

function chooseVersion(byteCount: number): number {
	for (let version = 1; version <= QR_MAX_VERSION; version++) {
		const countBits = version < 10 ? 8 : 16;
		if (4 + countBits + byteCount * 8 <= dataCodewords(version) * 8) return version;
	}
	throw new Error("The link is too long for a QR code");
}

/** Mode, length, data, terminator and padding, as data codewords. */
function dataBytes(bytes: Uint8Array, version: number): number[] {
	const bits: number[] = [];
	const push = (value: number, length: number) => {
		for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
	};
	push(0b0100, 4);
	push(bytes.length, version < 10 ? 8 : 16);
	for (const byte of bytes) push(byte, 8);
	const capacity = dataCodewords(version) * 8;
	push(0, Math.min(4, capacity - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	const out: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] as number);
		out.push(byte);
	}
	for (let pad = 0xec; out.length < dataCodewords(version); pad ^= 0xec ^ 0x11) out.push(pad);
	return out;
}

/** Split into blocks, add error correction, and interleave. */
function finalCodewords(data: number[], version: number): number[] {
	const spec = specFor(version);
	const blocks: Array<{ data: number[]; ec: number[] }> = [];
	let offset = 0;
	for (const [count, size] of spec.blocks) {
		for (let i = 0; i < count; i++) {
			const chunk = data.slice(offset, offset + size);
			offset += size;
			blocks.push({ data: chunk, ec: reedSolomon(chunk, spec.ec) });
		}
	}
	const out: number[] = [];
	const longest = Math.max(...blocks.map((b) => b.data.length));
	for (let i = 0; i < longest; i++) {
		for (const block of blocks) if (i < block.data.length) out.push(block.data[i] as number);
	}
	for (let i = 0; i < spec.ec; i++) {
		for (const block of blocks) out.push(block.ec[i] as number);
	}
	return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Matrix
// ────────────────────────────────────────────────────────────────────────────

class Grid {
	readonly modules: boolean[][];
	readonly isFunction: boolean[][];

	constructor(readonly size: number) {
		this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
		this.isFunction = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	}

	setFunction(x: number, y: number, dark: boolean): void {
		(this.modules[y] as boolean[])[x] = dark;
		(this.isFunction[y] as boolean[])[x] = true;
	}

	get(x: number, y: number): boolean {
		return (this.modules[y] as boolean[])[x] as boolean;
	}
}

function drawFinder(grid: Grid, cx: number, cy: number): void {
	for (let dy = -4; dy <= 4; dy++) {
		for (let dx = -4; dx <= 4; dx++) {
			const x = cx + dx;
			const y = cy + dy;
			if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) continue;
			const dist = Math.max(Math.abs(dx), Math.abs(dy));
			grid.setFunction(x, y, dist !== 2 && dist !== 4);
		}
	}
}

function drawAlignment(grid: Grid, cx: number, cy: number): void {
	for (let dy = -2; dy <= 2; dy++) {
		for (let dx = -2; dx <= 2; dx++) {
			grid.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}
	}
}

/** The 15 format bits (level M and the mask), with their BCH check bits. */
export function formatBits(mask: number): number {
	const data = (ECC_M << 3) | mask;
	let rem = data;
	for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
	return ((data << 10) | rem) ^ 0x5412;
}

/** The 18 version bits (versions 7 and up), with their BCH check bits. */
export function versionBits(version: number): number {
	let rem = version;
	for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
	return (version << 12) | rem;
}

function drawFormat(grid: Grid, mask: number): void {
	const bits = formatBits(mask);
	const bit = (i: number) => ((bits >>> i) & 1) !== 0;
	const size = grid.size;
	for (let i = 0; i <= 5; i++) grid.setFunction(8, i, bit(i));
	grid.setFunction(8, 7, bit(6));
	grid.setFunction(8, 8, bit(7));
	grid.setFunction(7, 8, bit(8));
	for (let i = 9; i < 15; i++) grid.setFunction(14 - i, 8, bit(i));
	for (let i = 0; i < 8; i++) grid.setFunction(size - 1 - i, 8, bit(i));
	for (let i = 8; i < 15; i++) grid.setFunction(8, size - 15 + i, bit(i));
	// The dark module, always on.
	grid.setFunction(8, size - 8, true);
}

function drawVersion(grid: Grid, version: number): void {
	if (version < 7) return;
	const bits = versionBits(version);
	for (let i = 0; i < 18; i++) {
		const dark = ((bits >>> i) & 1) !== 0;
		const a = grid.size - 11 + (i % 3);
		const b = Math.floor(i / 3);
		grid.setFunction(a, b, dark);
		grid.setFunction(b, a, dark);
	}
}

function drawFunctionPatterns(grid: Grid, version: number): void {
	const size = grid.size;
	for (let i = 0; i < size; i++) {
		grid.setFunction(6, i, i % 2 === 0);
		grid.setFunction(i, 6, i % 2 === 0);
	}
	drawFinder(grid, 3, 3);
	drawFinder(grid, size - 4, 3);
	drawFinder(grid, 3, size - 4);
	const align = specFor(version).align;
	const last = align.length - 1;
	for (let i = 0; i < align.length; i++) {
		for (let j = 0; j < align.length; j++) {
			// Not over the three finder patterns.
			if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
			drawAlignment(grid, align[i] as number, align[j] as number);
		}
	}
	// Reserve the format areas (drawn for real once the mask is chosen).
	drawFormat(grid, 0);
	drawVersion(grid, version);
}

/** Data bits in the standard zigzag, two columns at a time from the right. */
function drawCodewords(grid: Grid, codewords: number[]): void {
	const size = grid.size;
	let i = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vert = 0; vert < size; vert++) {
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? size - 1 - vert : vert;
				if ((grid.isFunction[y] as boolean[])[x]) continue;
				if (i < codewords.length * 8) {
					const dark = (((codewords[i >>> 3] as number) >>> (7 - (i & 7))) & 1) !== 0;
					(grid.modules[y] as boolean[])[x] = dark;
					i++;
				}
				// Remainder bits stay light.
			}
		}
	}
}

export function maskApplies(mask: number, x: number, y: number): boolean {
	switch (mask) {
		case 0:
			return (x + y) % 2 === 0;
		case 1:
			return y % 2 === 0;
		case 2:
			return x % 3 === 0;
		case 3:
			return (x + y) % 3 === 0;
		case 4:
			return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
		case 5:
			return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6:
			return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		case 7:
			return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
		default:
			throw new Error(`No QR mask ${mask}`);
	}
}

/** XOR the mask over every data module; applying it twice undoes it. */
function applyMask(grid: Grid, mask: number): void {
	for (let y = 0; y < grid.size; y++) {
		for (let x = 0; x < grid.size; x++) {
			if (!(grid.isFunction[y] as boolean[])[x] && maskApplies(mask, x, y)) {
				(grid.modules[y] as boolean[])[x] = !grid.get(x, y);
			}
		}
	}
}

/** The standard's penalty score; the mask with the lowest one is used. */
function penalty(grid: Grid): number {
	const size = grid.size;
	let score = 0;
	const line = (get: (i: number) => boolean) => {
		// Runs of five or more of one colour.
		let run = 1;
		for (let i = 1; i <= size; i++) {
			if (i < size && get(i) === get(i - 1)) {
				run++;
			} else {
				if (run >= 5) score += 3 + (run - 5);
				run = 1;
			}
		}
		// Finder-like 1:1:3:1:1 with four light modules on either side.
		for (let i = 0; i + 11 <= size; i++) {
			const pattern = [true, false, true, true, true, false, true];
			const core = pattern.every((v, k) => get(i + k + 4) === v);
			const before = [0, 1, 2, 3].every((k) => !get(i + k));
			const coreAt0 = pattern.every((v, k) => get(i + k) === v);
			const after = [7, 8, 9, 10].every((k) => !get(i + k));
			if (core && before) score += 40;
			if (coreAt0 && after) score += 40;
		}
	};
	for (let y = 0; y < size; y++) line((x) => grid.get(x, y));
	for (let x = 0; x < size; x++) line((y) => grid.get(x, y));
	// 2×2 blocks of one colour.
	for (let y = 0; y + 1 < size; y++) {
		for (let x = 0; x + 1 < size; x++) {
			const c = grid.get(x, y);
			if (c === grid.get(x + 1, y) && c === grid.get(x, y + 1) && c === grid.get(x + 1, y + 1)) {
				score += 3;
			}
		}
	}
	// Balance of dark and light.
	let dark = 0;
	for (const row of grid.modules) for (const m of row) if (m) dark++;
	const total = size * size;
	const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
	return score + Math.max(0, k) * 10;
}

/** Encode text (UTF-8) as a QR code at error correction level M. */
export function encodeQr(text: string): QrCode {
	const bytes = new TextEncoder().encode(text);
	const version = chooseVersion(bytes.length);
	const size = version * 4 + 17;
	const grid = new Grid(size);
	drawFunctionPatterns(grid, version);
	drawCodewords(grid, finalCodewords(dataBytes(bytes, version), version));

	let best = 0;
	let bestScore = Number.POSITIVE_INFINITY;
	for (let mask = 0; mask < 8; mask++) {
		applyMask(grid, mask);
		drawFormat(grid, mask);
		const score = penalty(grid);
		if (score < bestScore) {
			best = mask;
			bestScore = score;
		}
		applyMask(grid, mask);
	}
	applyMask(grid, best);
	drawFormat(grid, best);
	return { version, size, mask: best, modules: grid.modules };
}

/**
 * One SVG path drawing every dark module, offset by `margin` modules of
 * quiet zone. Use with `viewBox="0 0 {size + 2·margin} {size + 2·margin}"`.
 */
export function qrPath(code: QrCode, margin = 4): string {
	const parts: string[] = [];
	for (let y = 0; y < code.size; y++) {
		for (let x = 0; x < code.size; x++) {
			if ((code.modules[y] as boolean[])[x]) parts.push(`M${x + margin} ${y + margin}h1v1h-1z`);
		}
	}
	return parts.join("");
}
