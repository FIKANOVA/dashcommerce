import React from "react";
import { describe, expect, it } from "bun:test";

// Supply a minimal dispatcher so components using hooks (useState, useId, useRef) can be invoked directly
(React as any).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = {
	useState: (init: any) => [typeof init === "function" ? init() : init, () => {}],
	useEffect: () => {},
	useRef: (init: any) => ({ current: init }),
	useId: () => ":r0:",
	useMemo: (fn: any) => fn(),
	useCallback: (fn: any) => fn(),
};

import {
	Card,
	DC_THEME,
	Input,
	NumberInput,
	Select,
	Table,
} from "../src/admin/kit";
import { StatusBadge } from "../src/admin/ui/StatusBadge";

// WCAG 2.1 relative luminance and contrast calculation helper
function sRGBtoLin(c: number): number {
	const cs = c / 255;
	return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}

function relLum(r: number, g: number, b: number): number {
	return 0.2126 * sRGBtoLin(r) + 0.7152 * sRGBtoLin(g) + 0.0722 * sRGBtoLin(b);
}

function contrast(l1: number, l2: number): number {
	const lighter = Math.max(l1, l2);
	const darker = Math.min(l1, l2);
	return (lighter + 0.05) / (darker + 0.05);
}

describe("Admin UI Contrast & Token Semantics", () => {
	it("DC_THEME defines matched foreground and background token pairs", () => {
		expect(DC_THEME.cardBg).toContain("#fff");
		expect(DC_THEME.cardFg).toBe("var(--dc-card-fg, #18181b)");
		expect(DC_THEME.inputBg).toContain("#fff");
		expect(DC_THEME.inputFg).toBe("var(--dc-input-fg, #18181b)");
	});

	it("Card component pairs background with explicit dark text to avoid host dark-mode leakage", () => {
		const card = Card({ title: "Order Settings", children: "Body content" });
		expect(card.props.style?.background).toBe("var(--dc-card-bg, #fff)");
		expect(card.props.style?.color).toBe("var(--dc-card-fg, #18181b)");

		// Header must also explicitly enforce foreground color
		const header = card.props.children[0];
		expect(header.props.style?.color).toBe("var(--dc-card-fg, #18181b)");
	});

	it("Input component explicitly defines both background and foreground colors", () => {
		const inputOnly = Input({});
		expect(inputOnly.props.style?.background).toBe("var(--dc-input-bg, #fff)");
		expect(inputOnly.props.style?.color).toBe("var(--dc-input-fg, #18181b)");

		const inputWithLabel = Input({ label: "API Key" });
		// Outer label element
		expect(inputWithLabel.props.style?.color).toBe("var(--dc-label, #3f3f46)");
	});

	it("Select component defines paired background, foreground, and options", () => {
		const select = Select({
			options: [{ value: "usd", label: "USD" }],
		});
		expect(select.props.style?.background).toBe("var(--dc-input-bg, #fff)");
		expect(select.props.style?.color).toBe("var(--dc-input-fg, #18181b)");

		const option = select.props.children[0];
		expect(option.props.style?.color).toBe("#18181b");
		expect(option.props.style?.background).toBe("#fff");
	});

	it("NumberInput component defines paired background and foreground colors", () => {
		const numberInput = NumberInput({
			value: 42,
			onChange: () => {},
			prefix: "$",
			suffix: "USD",
		});
		expect(numberInput.props.style?.background).toBe("var(--dc-input-bg, #fff)");
		expect(numberInput.props.style?.color).toBe("var(--dc-input-fg, #18181b)");

		// Inner input element
		const inputChild = numberInput.props.children.find(
			(c: any) => c && c.type === "input",
		);
		expect(inputChild.props.style?.color).toBe("var(--dc-input-fg, #18181b)");
	});

	it("Table component enforces explicit text colors on table, header, and data cells", () => {
		const table = Table({
			columns: [{ key: "id", header: "Order ID" }],
			data: [{ id: "order_123" }],
		});
		const tableEl = table.props.children;
		expect(tableEl.props.style?.color).toBe("var(--dc-card-fg, #18181b)");

		// Check thead th color
		const thead = tableEl.props.children[0];
		const th = thead.props.children.props.children[0];
		expect(th.props.style?.color).toBe("var(--dc-text-muted, #3f3f46)");

		// Check tbody td color
		const tbody = tableEl.props.children[1];
		const tr = tbody.props.children[0];
		expect(tr.props.style?.color).toBe("var(--dc-card-fg, #18181b)");
		const td = tr.props.children[0];
		expect(td.props.style?.color).toBe("var(--dc-card-fg, #18181b)");
	});

	it("StatusBadge for pending status uses accessible amber-900 (#78350f)", () => {
		const badge = StatusBadge({ status: "pending" });
		expect(badge.props.style?.background).toBe("#78350f");
		expect(badge.props.style?.color).toBe("#fff");

		// Math verification: white on #78350f
		const lumWhite = relLum(255, 255, 255);
		const lumAmber900 = relLum(120, 53, 15);
		const cr = contrast(lumWhite, lumAmber900);
		expect(cr).toBeGreaterThanOrEqual(7.0); // Exceeds AAA 7.0:1
	});

	it("WCAG AA mathematical verification of all standardized text colors on white background", () => {
		const lumWhite = relLum(255, 255, 255);

		// #18181b (primary text)
		const lum18181b = relLum(24, 24, 27);
		expect(contrast(lumWhite, lum18181b)).toBeGreaterThan(15.0); // ~17.8:1

		// #3f3f46 (labels, th)
		const lum3f3f46 = relLum(63, 63, 70);
		expect(contrast(lumWhite, lum3f3f46)).toBeGreaterThan(10.0); // ~10.5:1

		// #52525b (subtle, hints, empty states)
		const lum52525b = relLum(82, 82, 91);
		expect(contrast(lumWhite, lum52525b)).toBeGreaterThan(7.0); // ~7.73:1 (passes AA 4.5:1 and AAA 7:1)

		// #854d0e (StickyBar unsaved changes)
		const lum854d0e = relLum(133, 77, 14);
		expect(contrast(lumWhite, lum854d0e)).toBeGreaterThan(6.0); // ~6.85:1 (passes AA 4.5:1)

		// #6b7280 (existing metadata text on white card)
		const lum6b7280 = relLum(107, 114, 128);
		expect(contrast(lumWhite, lum6b7280)).toBeGreaterThan(4.5); // 4.83:1 (passes AA 4.5:1)
	});
});
