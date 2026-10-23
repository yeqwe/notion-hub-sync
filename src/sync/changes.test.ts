// Pending-changes scanner: the panel's "git status" list.
//
// It reads the same base (state.entries) and the same vault listing the
// engine uses, so the list can never promise something a sync won't do.
// The tests below pin the cases that used to be invisible: a locally
// deleted file, a rename in flight, and paths excluded from the scope.

import { describe, expect, it } from "vitest";
import { scanPendingChanges, statusMark } from "../sync/changes";
import { emptyState, type SyncEntry, type SyncState } from "../sync/state";

function stateWith(entries: Array<[string, SyncEntry]>): SyncState {
	const st = emptyState("root");
	for (const [id, e] of entries) st.entries[id] = e;
	return st;
}

function entry(path: string, over: Partial<SyncEntry> = {}): SyncEntry {
	return {
		path,
		kind: path.endsWith(".md") ? "note" : "file",
		notionTitle: path,
		parentId: "root",
		localMtime: 1000,
		localSize: 10,
		...over,
	};
}

const file = (path: string, mtime = 1000, size = 10) => ({
	path,
	size,
	mtime,
});

describe("scanPendingChanges", () => {
	it("reports nothing when the vault matches the base", () => {
		const st = stateWith([["a", entry("a.md")]]);
		expect(scanPendingChanges({ state: st, files: [file("a.md")] })).toEqual(
			[],
		);
	});

	it("flags a new local file", () => {
		const st = stateWith([]);
		const out = scanPendingChanges({ state: st, files: [file("new.md")] });
		expect(out).toEqual([{ path: "new.md", status: "new", name: "new.md" }]);
	});

	it("flags a file modified since the last sync", () => {
		const st = stateWith([["a", entry("a.md")]]);
		const out = scanPendingChanges({
			state: st,
			files: [file("a.md", 2000, 10)],
		});
		expect(out.map((c) => c.status)).toEqual(["modified"]);
	});

	it("treats a changed size as modified even when the mtime matches", () => {
		const st = stateWith([["a", entry("a.md")]]);
		const out = scanPendingChanges({
			state: st,
			files: [file("a.md", 1000, 99)],
		});
		expect(out.map((c) => c.status)).toEqual(["modified"]);
	});

	it("flags a file deleted locally", () => {
		const st = stateWith([["a", entry("gone.md")]]);
		const out = scanPendingChanges({ state: st, files: [] });
		expect(out).toEqual([{ path: "gone.md", status: "deleted", name: "gone.md" }]);
	});

	it("turns a rename hint into a rename, not a delete plus an add", () => {
		const st = stateWith([["a", entry("old.md")]]);
		const out = scanPendingChanges({
			state: st,
			files: [file("renamed.md")],
			renameHints: [{ from: "old.md", to: "renamed.md" }],
		});
		expect(out.map((c) => [c.path, c.status])).toEqual([
			["renamed.md", "renamed"],
		]);
	});

	it("reports a rename that also changed content as renamed + modified", () => {
		const st = stateWith([["a", entry("old.md")]]);
		const out = scanPendingChanges({
			state: st,
			files: [file("renamed.md", 5000, 10)],
			renameHints: [{ from: "old.md", to: "renamed.md" }],
		});
		expect(out.map((c) => c.status)).toEqual(["renamed", "modified"]);
	});

	it("skips entries whose local file is blocked", () => {
		const st = stateWith([["a", entry("big.zip")]]);
		const out = scanPendingChanges({
			state: st,
			files: [file("big.zip", 5000, 10)],
			blocked: [{ path: "big.zip", reason: "oversized" }],
		});
		expect(out).toEqual([]);
	});

	it("ignores excluded folders", () => {
		const st = stateWith([]);
		const out = scanPendingChanges({
			state: st,
			files: [file("Private/secret.md"), file("ok.md")],
			scope: {
				images: true,
				audio: true,
				video: true,
				pdf: true,
				other: true,
				excludedFolders: ["Private"],
			},
		});
		expect(out.map((c) => c.path)).toEqual(["ok.md"]);
	});

	it("ignores hidden paths (config dirs, .trash)", () => {
		const st = stateWith([]);
		const out = scanPendingChanges({
			state: st,
			files: [file(".obsidian/app.json"), file(".trash/x.md"), file("a.md")],
		});
		expect(out.map((c) => c.path)).toEqual(["a.md"]);
	});

	it("sorts by path and honours the limit", () => {
		const st = stateWith([]);
		const files = ["c.md", "a.md", "b.md", "d.md"].map((p) => file(p));
		const out = scanPendingChanges({ state: st, files, limit: 2 });
		expect(out.map((c) => c.path)).toEqual(["a.md", "b.md"]);
	});

	it("never lists a folder — folders carry no content", () => {
		const st = stateWith([
			[
				"dir",
				{ ...entry("Dir"), kind: "folder", localMtime: undefined },
			],
		]);
		expect(scanPendingChanges({ state: st, files: [] })).toEqual([]);
	});
});

describe("statusMark", () => {
	it("uses git's letters", () => {
		expect(statusMark("new")).toBe("U");
		expect(statusMark("modified")).toBe("M");
		expect(statusMark("renamed")).toBe("R");
		expect(statusMark("deleted")).toBe("D");
	});
});
