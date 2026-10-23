// The number field's rules, kept pure so they are testable without a DOM:
// what a typed string means, and how a stored value is fitted to the range.

import { describe, expect, it } from "vitest";
import {
	bulkTargetValue,
	clampToStep,
	parseNumberInput,
	rangeHint,
} from "./settings-sections";

describe("bulkTargetValue", () => {
	it("turns everything on when something is off", () => {
		expect(bulkTargetValue([true, false, true])).toBe(true);
	});

	it("turns everything on from a fully-off row", () => {
		expect(bulkTargetValue([false, false])).toBe(true);
	});

	it("turns everything off only when all are on", () => {
		expect(bulkTargetValue([true, true, true])).toBe(false);
	});

	it("is a no-op direction for an empty row (nothing to toggle)", () => {
		// addMultiSelect returns early on an empty option list, so this value
		// is never used — but it must not be "off", which would read as a
		// state rather than "nothing to do".
		expect(bulkTargetValue([])).toBe(false);
	});
});

describe("clampToStep", () => {
	it("passes a value already on the grid", () => {
		expect(clampToStep(10, 0, 1440, 1)).toBe(10);
		expect(clampToStep(25, 5, 500, 5)).toBe(25);
	});

	it("clamps to the limits", () => {
		expect(clampToStep(-5, 0, 1440, 1)).toBe(0);
		expect(clampToStep(9999, 0, 1440, 1)).toBe(1440);
	});

	it("snaps to the nearest step", () => {
		expect(clampToStep(23, 5, 500, 5)).toBe(25);
		expect(clampToStep(22, 5, 500, 5)).toBe(20);
	});

	it("a stored value from an older range cannot escape the field", () => {
		// maxFileSizeMB used to accept any positive number; the field now
		// offers 1..2000. A stored 5000 must not survive on screen.
		expect(clampToStep(5000, 1, 2000, 1)).toBe(2000);
		expect(clampToStep(0, 1, 2000, 1)).toBe(1);
	});

	it("falls back to the minimum for a non-numeric value", () => {
		expect(clampToStep(Number.NaN, 1, 10, 1)).toBe(1);
		// Infinity is not "missing", it is "too big" — clamp, don't reset.
		expect(clampToStep(Number.POSITIVE_INFINITY, 1, 10, 1)).toBe(10);
		expect(clampToStep(Number.NEGATIVE_INFINITY, 1, 10, 1)).toBe(1);
	});

	it("treats a non-positive step as no snapping", () => {
		expect(clampToStep(3.7, 0, 10, 0)).toBe(3.7);
	});
});

describe("parseNumberInput", () => {
	it("reads a plain number", () => {
		expect(parseNumberInput("30")).toBe(30);
		expect(parseNumberInput("0")).toBe(0);
	});

	it("tolerates surrounding whitespace", () => {
		expect(parseNumberInput("  30  ")).toBe(30);
	});

	it("accepts decimals and negatives (clamping happens later)", () => {
		expect(parseNumberInput("2.5")).toBe(2.5);
		expect(parseNumberInput("-1")).toBe(-1);
	});

	it("an empty box means 'no answer', not zero", () => {
		// This is the whole reason the function exists: Number("") === 0 would
		// silently turn an emptied sync interval into "off".
		expect(parseNumberInput("")).toBeNull();
		expect(parseNumberInput("   ")).toBeNull();
	});

	it("rejects text", () => {
		expect(parseNumberInput("abc")).toBeNull();
		expect(parseNumberInput("10 min")).toBeNull();
	});
});

describe("rangeHint", () => {
	it("states the accepted range with its unit", () => {
		expect(rangeHint(0, 1440, "分钟")).toBe("0–1440 分钟");
		expect(rangeHint(1, 2000, "MB")).toBe("1–2000 MB");
	});

	it("omits the unit when there is none", () => {
		expect(rangeHint(1, 10, "")).toBe("1–10");
	});
});
