/**
 * A small QR decoder for tests, written separately from the encoder from
 * the standard: read the format bits, unmask, follow the zigzag, split the
 * blocks, check each block's Reed–Solomon codewords and read the bytes.
 * Level M, byte mode, versions 1 to 10, as the Counter sale page draws.
 */

import { type QrCode, maskApplies, reedSolomon } from "../../src/admin/qr";

function check(ok: boolean, message: string): void {
	if (!ok) throw new Error(`QR decode: ${message}`);
}

const ALIGN: number[][] = [
	[],
	[6, 18],
	[6, 22],
	[6, 26],
	[6, 30],
	[6, 34],
	[6, 22, 38],
	[6, 24, 42],
	[6, 26, 46],
	[6, 28, 50],
];
const BLOCKS: Array<{ ec: number; sizes: number[] }> = [
	{ ec: 10, sizes: [16] },
	{ ec: 16, sizes: [28] },
	{ ec: 26, sizes: [44] },
	{ ec: 18, sizes: [32, 32] },
	{ ec: 24, sizes: [43, 43] },
	{ ec: 16, sizes: [27, 27, 27, 27] },
	{ ec: 18, sizes: [31, 31, 31, 31] },
	{ ec: 22, sizes: [38, 38, 39, 39] },
	{ ec: 22, sizes: [36, 36, 36, 37, 37] },
	{ ec: 26, sizes: [43, 43, 43, 43, 44] },
];

function reserved(version: number): boolean[][] {
	const size = version * 4 + 17;
	const r = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
	const mark = (x: number, y: number) => {
		if (x >= 0 && y >= 0 && x < size && y < size) (r[y] as boolean[])[x] = true;
	};
	// Finders with separators and format areas: the 9×9 / 8×9 corners.
	for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) mark(x, y);
	for (let y = 0; y < 9; y++) for (let x = size - 8; x < size; x++) mark(x, y);
	for (let y = size - 8; y < size; y++) for (let x = 0; x < 9; x++) mark(x, y);
	for (let i = 0; i < size; i++) {
		mark(6, i);
		mark(i, 6);
	}
	const a = ALIGN[version - 1] as number[];
	for (const cy of a) {
		for (const cx of a) {
			if ((cx === 6 && cy === 6) || (cx === 6 && cy === a[a.length - 1]) || (cy === 6 && cx === a[a.length - 1]))
				continue;
			for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(cx + dx, cy + dy);
		}
	}
	if (version >= 7) {
		for (let i = 0; i < 6; i++) {
			for (let j = size - 11; j < size - 8; j++) {
				mark(i, j);
				mark(j, i);
			}
		}
	}
	return r;
}

export function decodeQr(code: QrCode): string {
	const { size, modules } = code;
	const version = (size - 17) / 4;
	const at = (x: number, y: number) => (modules[y] as boolean[])[x] as boolean;

	// Format bits, first copy, read independently of the encoder.
	let fmt = 0;
	const positions: Array<[number, number]> = [
		[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
		[7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
	];
	positions.forEach(([x, y], i) => {
		if (at(x, y)) fmt |= 1 << i;
	});
	fmt ^= 0x5412;
	check(fmt >>> 13 === 0, "error correction level is not M");
	const mask = (fmt >>> 10) & 7;
	check(mask === code.mask, `format bits say mask ${mask}, the encoder chose ${code.mask}`);

	// Second copy agrees.
	let fmt2 = 0;
	for (let i = 0; i < 8; i++) if (at(size - 1 - i, 8)) fmt2 |= 1 << i;
	for (let i = 8; i < 15; i++) if (at(8, size - 15 + i)) fmt2 |= 1 << i;
	check((fmt2 ^ 0x5412) === fmt, "the two copies of the format bits differ");
	check(at(8, size - 8), "the dark module is light");

	const skip = reserved(version);
	const bits: number[] = [];
	let upward = true;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let k = 0; k < size; k++) {
			const y = upward ? size - 1 - k : k;
			for (const x of [right, right - 1]) {
				if ((skip[y] as boolean[])[x]) continue;
				const masked = maskApplies(mask, x, y);
				bits.push(at(x, y) !== masked ? 1 : 0);
			}
		}
		upward = !upward;
	}
	const codewords: number[] = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) {
		codewords.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
	}

	const spec = BLOCKS[version - 1] as { ec: number; sizes: number[] };
	const blocks = spec.sizes.map(() => [] as number[]);
	let p = 0;
	const longest = Math.max(...spec.sizes);
	for (let i = 0; i < longest; i++) {
		spec.sizes.forEach((n, b) => {
			if (i < n) (blocks[b] as number[]).push(codewords[p++] as number);
		});
	}
	const ec = spec.sizes.map(() => [] as number[]);
	for (let i = 0; i < spec.ec; i++) {
		spec.sizes.forEach((_n, b) => (ec[b] as number[]).push(codewords[p++] as number));
	}
	blocks.forEach((block, b) => {
		check(
			reedSolomon(block, spec.ec).join() === (ec[b] as number[]).join(),
			`block ${b} fails its error correction check`,
		);
	});

	const data = blocks.flat();
	const stream = data.flatMap((byte) => Array.from({ length: 8 }, (_v, i) => (byte >>> (7 - i)) & 1));
	const read = (n: number) => {
		let v = 0;
		for (let i = 0; i < n; i++) v = (v << 1) | (stream.shift() as number);
		return v;
	};
	check(read(4) === 0b0100, "not byte mode");
	const length = read(version < 10 ? 8 : 16);
	const bytes = Uint8Array.from({ length }, () => read(8));
	return new TextDecoder().decode(bytes);
}
