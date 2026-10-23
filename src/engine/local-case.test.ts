// Case-only clashes. `Report.md` and `report.md` are ONE file on Windows
// and on macOS's default filesystem, so a vault holding both cannot be
// represented there at all — syncing either one overwrites the other.
//
// The scanner therefore refuses to evaluate BOTH: neither gets pushed,
// pulled or deleted, and both surface as a blocked path with a reason.
// Picking a winner is not an option — nothing here can know which one the
// user meant, and silently dropping either loses content.

import { describe, expect, it } from "vitest";
import { findCaseConflicts, snapshotLocal } from "./local";
import { emptyState, type SyncEntry } from "../sync/state";
import type { VaultIO } from "../sync/vault-io";

function fakeVault(files: string[], folders: string[] = []): VaultIO {
	let n = 0;
	return {
		list: async () => ({
			files: files.map((path) => ({ path, size: 10, mtime: 1 })),
			folders,
		}),
		readText: async () => "",
		readBinary: async () => new ArrayBuffer(0),
		writeText: async () => {},
		writeBinary: async () => {},
		mkdirp: async () => {},
		exists: async () => true,
		stat: async () => ({ size: 10, mtime: 1 }),
		rename: async () => {},
		trash: async () => {},
		renames: { expect() {}, consume: () => false },
		writes: { expect() {}, consume: () => false },
	} as unknown as VaultIO;
}

describe("findCaseConflicts", () => {
	it("reports nothing for distinct paths", () => {
		expect(findCaseConflicts(["a.md", "b.md"])).toEqual(new Map());
	});

	it("pairs paths that differ only by case", () => {
		const got = findCaseConflicts(["Report.md", "report.md"]);
		expect([...got.keys()].sort()).toEqual(["Report.md", "report.md"]);
		expect(got.get("Report.md")).toEqual(["report.md"]);
		expect(got.get("report.md")).toEqual(["Report.md"]);
	});

	it("groups three-way clashes and points each at the others", () => {
		const got = findCaseConflicts(["a.md", "A.md", "a.MD"]);
		expect(got.size).toBe(3);
		expect(got.get("a.md")).toEqual(["A.md", "a.MD"]);
	});
});

describe("snapshotLocal with case clashes", () => {
	function stateWith(entries: Array<[string, SyncEntry]>) {
		const st = emptyState("root");
		for (const [id, e] of entries) st.entries[id] = e;
		return st;
	}

	it("blocks both sides instead of pushing one over the other", async () => {
		const st = stateWith([
			[
				"aaa",
				{
					path: "Report.md",
					kind: "note",
					notionTitle: "Report",
					parentId: "root",
				},
			],
		]);
		const snap = await snapshotLocal(
			fakeVault(["Report.md", "report.md"]),
			st,
		);
		// both are blocked...
		expect(snap.blocked.map((b) => b.path).sort()).toEqual([
			"Report.md",
			"report.md",
		]);
		expect(snap.blocked.every((b) => b.reason === "caseConflict")).toBe(true);
		// ...the base entry is NOT evaluated (absent = unchanged for the
		// planner), so no push/pull/trash is planned for it...
		expect(snap.local["aaa"]).toBeUndefined();
		// ...and the twin never becomes a "new" item either.
		expect(snap.localAdded).toEqual([]);
	});

	it("leaves the unclashing neighbours alone", async () => {
		const st = stateWith([
			[
				"bbb",
				{
					path: "ok.md",
					kind: "note",
					notionTitle: "ok",
					parentId: "root",
				},
			],
		]);
		const snap = await snapshotLocal(
			fakeVault(["ok.md", "X.md", "x.md"]),
			st,
		);
		expect(snap.local["bbb"]?.deleted).toBe(false);
		expect(snap.blocked.map((b) => b.path).sort()).toEqual(["X.md", "x.md"]);
	});

	it("says which paths clashed", async () => {
		const snap = await snapshotLocal(fakeVault(["A.md", "a.md"]), emptyState("root"));
		const a = snap.blocked.find((b) => b.path === "A.md");
		expect(a?.detail).toContain("a.md");
	});

	it("reports no conflict when only one of the pair exists locally", async () => {
		const snap = await snapshotLocal(fakeVault(["report.md"]), emptyState("root"));
		expect(snap.blocked).toEqual([]);
		expect(snap.localAdded.map((a) => a.path)).toEqual(["report.md"]);
	});
});
