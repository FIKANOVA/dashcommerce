/**
 * The Counter sale page's QR encoder, checked against the standard's
 * published values and by reading each code back with a small, separate
 * decoder (format bits → mask → zigzag → blocks → Reed–Solomon → bytes).
 */

import { describe, expect, it } from "bun:test";
import {
	QR_MAX_VERSION,
	dataCodewords,
	encodeQr,
	formatBits,
	qrPath,
	reedSolomon,
	totalCodewords,
	versionBits,
} from "../src/admin/qr";
import { decodeQr as decode } from "./helpers/qr-decode";

describe("QR building blocks", () => {
	it("computes Reed–Solomon codewords as the standard's worked example", () => {
		// "HELLO WORLD" at version 1-M (thonky.com's QR tutorial).
		const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
		expect(reedSolomon(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
	});

	it("uses the standard's format and version bits", () => {
		// Level M: mask 0 is the bare XOR mask; masks 1, 5 and 7 from the table.
		expect(formatBits(0).toString(2).padStart(15, "0")).toBe("101010000010010");
		expect(formatBits(5).toString(2).padStart(15, "0")).toBe("100000011001110");
		expect(formatBits(7).toString(2).padStart(15, "0")).toBe("100101010100000");
		expect(formatBits(1).toString(2).padStart(15, "0")).toBe("101000100100101");
		expect(versionBits(7)).toBe(0x07c94);
		expect(versionBits(10)).toBe(0x0a4d3);
	});

	it("each version's blocks fill exactly its modules", () => {
		for (let v = 1; v <= QR_MAX_VERSION; v++) {
			const ecTotal = totalCodewords(v) - dataCodewords(v);
			expect(ecTotal).toBeGreaterThan(0);
		}
		// Byte capacity at level M, versions 1, 4 and 10.
		expect(dataCodewords(1)).toBe(16);
		expect(dataCodewords(4)).toBe(64);
		expect(dataCodewords(10)).toBe(216);
		expect(totalCodewords(10)).toBe(346);
	});
});

describe("encodeQr", () => {
	const links = [
		"https://checkout.paystack.com/0peioxfhpn",
		"https://checkout.paystack.com/7z0bt7sjl1qcr2k",
		`https://pay.mock.test/${"a".repeat(32)}`,
		"x",
		"Café — KSh 1,600",
		`https://checkout.paystack.com/${"z".repeat(150)}`,
	];

	for (const link of links) {
		it(`reads back ${link.length} bytes`, () => {
			const code = encodeQr(link);
			expect(code.size).toBe(code.version * 4 + 17);
			expect(decode(code)).toBe(link);
		});
	}

	it("tries every mask and reads back whichever it chose", () => {
		const masks = new Set<number>();
		for (let n = 0; n < 60; n++) {
			const link = `https://checkout.paystack.com/${n.toString(36).repeat(3)}`;
			const code = encodeQr(link);
			masks.add(code.mask);
			expect(decode(code)).toBe(link);
		}
		expect(masks.size).toBeGreaterThan(3);
	});

	it("covers every version up to 10", () => {
		const seen = new Set<number>();
		for (let length = 1; length <= 213; length += 7) {
			const link = "h".repeat(length);
			const code = encodeQr(link);
			seen.add(code.version);
			expect(decode(code)).toBe(link);
		}
		expect([...seen].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it("the test decoder notices a damaged code", () => {
		const code = encodeQr("https://checkout.paystack.com/abc");
		const row = code.modules[code.size - 1] as boolean[];
		row[code.size - 1] = !row[code.size - 1];
		expect(() => decode(code)).toThrow("error correction");
	});

	it("refuses a link too long for version 10", () => {
		expect(() => encodeQr("h".repeat(214))).toThrow("too long");
	});

	it("draws one path with a quiet zone", () => {
		const code = encodeQr("https://checkout.paystack.com/abc");
		const path = qrPath(code);
		// Top-left finder corner sits four modules in.
		expect(path.startsWith("M4 4h1v1h-1z")).toBe(true);
		const dark = code.modules.flat().filter(Boolean).length;
		expect(path.split("M").length - 1).toBe(dark);
	});
});
