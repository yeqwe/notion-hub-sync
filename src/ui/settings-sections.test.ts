// bulkTargetValue is the one rule behind the "All / None" chip: if anything
// is off, the click turns everything on; only when everything is already on
// does it turn them all off. Extracted from the DOM code so the direction is
// testable without a browser.

import { describe, expect, it } from "vitest";
import { bulkTargetValue, clampToStep, sliderReadout } from "./settings-sections";

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
		expect(clampToStep(10, 0, 240, 1)).toBe(10);
		expect(clampToStep(25, 5, 500, 5)).toBe(25);
	});

	it("clamps to the limits", () => {
		expect(clampToStep(-5, 0, 240, 1)).toBe(0);
		expect(clampToStep(9999, 0, 240, 1)).toBe(240);
	});

	it("snaps to the nearest step", () => {
		expect(clampToStep(23, 5, 500, 5)).toBe(25);
		expect(clampToStep(22, 5, 500, 5)).toBe(20);
	});

	it("a stored value from an older range cannot escape the slider", () => {
		// maxFileSizeMB used to accept any positive number; the slider now
		// offers 1..1000 in steps of 1. A stored 5000 must not render off-grid.
		expect(clampToStep(5000, 1, 1000, 1)).toBe(1000);
		expect(clampToStep(0, 1, 1000, 1)).toBe(1);
	});

	it("falls back to the minimum for a non-numeric value", () => {
		expect(clampToStep(Number.NaN, 1, 10, 1)).toBe(1);
		expect(clampToStep(Number.POSITIVE_INFINITY, 1, 10, 1)).toBe(10);
	});

	it("treats a non-positive step as no snapping", () => {
		expect(clampToStep(3.7, 0, 10, 0)).toBe(3.7);
	});
});

describe("sliderReadout", () => {
	it("joins the number and its unit", () => {
		expect(sliderReadout(10, "min")).toBe("10 min");
		expect(sliderReadout(10, "分钟")).toBe("10 分钟");
	});

	it("shows the off label at zero when the setting uses 0 as off", () => {
		expect(sliderReadout(0, "分钟", "关闭")).toBe("关闭");
		expect(sliderReadout(5, "分钟", "关闭")).toBe("5 分钟");
	});

	it("keeps the plain number when 0 is a real value", () => {
		expect(sliderReadout(0, "files")).toBe("0 files");
	});
});
