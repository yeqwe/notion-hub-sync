// bulkTargetValue is the one rule behind the "All / None" chip: if anything
// is off, the click turns everything on; only when everything is already on
// does it turn them all off. Extracted from the DOM code so the direction is
// testable without a browser.

import { describe, expect, it } from "vitest";
import { bulkTargetValue } from "./settings-sections";

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
