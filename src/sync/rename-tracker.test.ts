// The tracker is what tells the vault-event listeners "this write was ours".
// A stale entry is worse than a missing one: it silently swallows a REAL user
// operation on the same path, which then never syncs.

import { describe, expect, it } from "vitest";
import { RenameTracker } from "./rename-tracker";

describe("RenameTracker", () => {
	it("consumes an expected pair exactly once", () => {
		const t = new RenameTracker();
		t.expect("a.md", "a.md");
		expect(t.consume("a.md", "a.md")).toBe(true);
		expect(t.consume("a.md", "a.md")).toBe(false);
	});

	it("ignores pairs it did not register", () => {
		const t = new RenameTracker();
		t.expect("a.md", "b.md");
		expect(t.consume("b.md", "a.md")).toBe(false);
	});

	it("forget withdraws an expectation that will never fire", () => {
		// e.g. mkdirp found the folder already there, so no create event came
		const t = new RenameTracker();
		t.expect("dir", "dir");
		t.forget("dir", "dir");
		expect(t.consume("dir", "dir")).toBe(false);
		// and the path is free again for a genuine user operation
		t.expect("dir", "dir");
		expect(t.consume("dir", "dir")).toBe(true);
	});

	it("forgetting an unknown pair is a no-op", () => {
		const t = new RenameTracker();
		t.forget("x", "y");
		expect(t.consume("x", "y")).toBe(false);
	});
});
