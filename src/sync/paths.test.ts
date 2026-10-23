// Conflict-copy naming: one matcher for the whole plugin.
//
// The loose version (`/ \(conflict [^)]*\)/`) hid a user's own
// `报告 (conflict 草稿).md` from sync and listed it as a copy in the status
// modal. The matcher now only accepts what `conflictPath` actually writes.

import { describe, expect, it } from "vitest";
import { conflictPath, collisionFreePath, isConflictCopyPath } from "../sync/paths";

describe("conflictPath", () => {
	it("round-trips through the matcher", () => {
		const when = new Date("2026-03-04T05:06:07.089Z");
		const name = conflictPath("a/b/note.md", "dev12345", when);
		expect(isConflictCopyPath(name)).toBe(true);
		expect(name).toContain("(conflict dev12345 2026-03-04T05-06-07-089Z)");
	});

	it("round-trips for an extensionless file", () => {
		const name = conflictPath(
			"Makefile",
			"dev",
			new Date("2026-01-02T03:04:05.006Z"),
		);
		expect(isConflictCopyPath(name)).toBe(true);
	});

	it("round-trips for a binary path", () => {
		const name = conflictPath(
			"img/photo.png",
			"abc",
			new Date("2026-12-31T23:59:59.999Z"),
		);
		expect(isConflictCopyPath(name)).toBe(true);
	});
});

describe("isConflictCopyPath", () => {
	it("rejects a user's own parenthesized name", () => {
		// this is the regression the strict matcher exists for
		expect(isConflictCopyPath("报告 (conflict 草稿).md")).toBe(false);
		expect(isConflictCopyPath("notes (conflict).md")).toBe(false);
		expect(isConflictCopyPath("a (conflict old version).md")).toBe(false);
	});

	it("rejects plain files", () => {
		expect(isConflictCopyPath("note.md")).toBe(false);
		expect(isConflictCopyPath("a/b/note.md")).toBe(false);
	});

	it("rejects Obsidian's own conflicted copies", () => {
		// a different feature with a different lifecycle: never ours
		expect(isConflictCopyPath("note (Conflicted copy 2024-01-01).md")).toBe(
			false,
		);
	});

	it("accepts the legacy second-precision form (old copies in the wild)", () => {
		// copies written before the format was pinned have no milliseconds;
		// they are still in users' vaults and must stay recognized
		expect(
			isConflictCopyPath("appearance (conflict abc 2026-01-01T00-00-00Z).json"),
		).toBe(true);
	});

	it("rejects a bare date with no time — not our shape", () => {
		expect(isConflictCopyPath("note (conflict abc 2026-01-01).md")).toBe(false);
	});

	it("accepts any stem and directory before the marker", () => {
		const when = new Date("2026-01-02T03:04:05.006Z");
		expect(isConflictCopyPath(conflictPath("deep/x.md", "d1", when))).toBe(
			true,
		);
		// a name that is itself long/unusual is fine — the marker is what counts
		expect(
			isConflictCopyPath(
				conflictPath("a (conflict old).md", "d1", when),
			),
		).toBe(true);
	});
});

describe("collisionFreePath", () => {
	it("appends a counter before the extension", () => {
		const used = new Set(["note.md"]);
		expect(collisionFreePath("", "note.md", used)).toBe("note (2).md");
	});

	it("treats paths case-insensitively (one file on Windows/macOS)", () => {
		const used = new Set(["note.md"]);
		expect(collisionFreePath("", "NOTE.md", used)).toBe("NOTE (2).md");
	});
});
