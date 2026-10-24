// Collision guards for the actions that MOVE or MATERIALISE a local path.
//
// A destination is not automatically free. The user may have created a note
// with that name in the meantime, a previous round may have restored a copy,
// or a plain file may still sit exactly where a folder has to be created.
// Writing blind then either overwrites that file (silent data loss — POSIX
// `rename` clobbers) or throws on every round (Windows refuses; the action
// can never land, so the two sides never converge).
//
// `pullNew` always had this guard; `moveLocal`, `restoreLocal` and
// `createLocalFolder` did not. A full round cannot produce these collisions
// deterministically (the planner derives paths from the same state), yet a
// remote rename or an interrupted round hands the applier exactly this, so
// the actions are driven directly here.

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, type Device } from "../../test-support/device";
import { applyActions, type ApplyCtx } from "./apply";
import { newReport } from "../sync/deps";
import type { SyncEntry } from "../sync/state";
import type { Action } from "./types";
import type { LocalSnapshot } from "./local";
import type { RemoteSnapshot } from "./remote";

function setup(): { a: Device } {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	return { a: makeDevice(fake, rootId, "a") };
}

function entry(path: string, over: Partial<SyncEntry> = {}): SyncEntry {
	return {
		path,
		kind: path.toLowerCase().endsWith(".md") ? "note" : "file",
		notionTitle: path,
		parentId: "root",
		...over,
	};
}

function emptyRemote(): RemoteSnapshot {
	return {
		remote: {},
		remoteAdded: [],
		fetchedBytes: new Map(),
		fetchedMeta: new Map(),
		seenIds: null,
		auditDue: false,
		journalSeen: [],
		searchCursor: undefined,
		journalCandidateIds: [],
	};
}

function emptyLocal(): LocalSnapshot {
	return {
		local: {},
		localAdded: [],
		pathOf: new Map(),
		folderIdByPath: new Map(),
		claimed: new Set(),
		blocked: [],
		massDeletion: false,
		seenNow: new Map(),
		stats: {
			listedFiles: 0,
			listedFolders: 0,
			reused: 0,
			hashed: 0,
			renames: 0,
		},
	};
}

function ctxFor(
	a: Device,
	over: Partial<ApplyCtx> = {},
): ApplyCtx {
	return {
		deps: a.deps,
		report: newReport(),
		localSnap: emptyLocal(),
		remoteSnap: emptyRemote(),
		baseStore: a.deps.baseStore,
		journalOps: [],
		newRemoteFolders: new Map(),
		recreated: new Map(),
		...over,
	};
}

/** Files on disk, written without going through the engine. */
function putRaw(a: Device, path: string, text: string): void {
	const abs = join(a.dir, ...path.split("/"));
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, text);
}

function raw(a: Device, path: string): string {
	return readFileSync(join(a.dir, ...path.split("/")), "utf8");
}

describe("local path collisions", () => {
	it("moveLocal lands beside a file that already has the target name", async () => {
		const { a } = setup();
		putRaw(a, "src.md", "MOVED\n");
		putRaw(a, "dst.md", "USER\n");
		a.state.entries["aaaa"] = entry("src.md");
		a.state.entries["bbbb"] = entry("dst.md");
		const ctx = ctxFor(a);

		const actions: Action[] = [
			{
				type: "moveLocal",
				id: "aaaa",
				parent: { newLocal: "" },
				name: "dst.md",
			},
		];
		await applyActions(actions, ctx);

		// the file that was already there is untouched
		expect(raw(a, "dst.md")).toBe("USER\n");
		// the moved note is beside it, not on top of it
		expect(raw(a, "dst (2).md")).toBe("MOVED\n");
		expect(a.state.entries["aaaa"]!.path).toBe("dst (2).md");
		expect(ctx.report.warnings.join("\n")).toContain("already exists");
	});

	it("moveLocal still uses the plain name when the target is free", async () => {
		const { a } = setup();
		putRaw(a, "src.md", "MOVED\n");
		a.state.entries["aaaa"] = entry("src.md");
		const ctx = ctxFor(a);

		await applyActions(
			[
				{
					type: "moveLocal",
					id: "aaaa",
					parent: { newLocal: "Dir" },
					name: "src.md",
				},
			],
			ctx,
		);

		expect(raw(a, "Dir/src.md")).toBe("MOVED\n");
		expect(existsSync(join(a.dir, "src.md"))).toBe(false);
		expect(a.state.entries["aaaa"]!.path).toBe("Dir/src.md");
		expect(ctx.report.warnings).toEqual([]);
	});

	it("restoreLocal does not overwrite a file created at the same path", async () => {
		const { a } = setup();
		// the local copy was deleted; the user has since made a NEW note here
		putRaw(a, "note.md", "NEW LOCAL\n");
		a.state.entries["cccc"] = entry("note.md");
		const remote = emptyRemote();
		remote.remote["cccc"] = {
			deleted: false,
			parent: { id: "root" },
			name: "note.md",
			sha: null,
		};
		remote.fetchedBytes.set(
			"cccc",
			new TextEncoder().encode("FROM NOTION\n"),
		);
		const ctx = ctxFor(a, { remoteSnap: remote });

		await applyActions([{ type: "restoreLocal", id: "cccc" }], ctx);

		expect(raw(a, "note.md")).toBe("NEW LOCAL\n");
		expect(raw(a, "note (2).md")).toBe("FROM NOTION\n");
		expect(a.state.entries["cccc"]!.path).toBe("note (2).md");
	});

	it("createLocalFolder does not land on an existing file", async () => {
		const { a } = setup();
		putRaw(a, "Dir", "I am a file\n");
		const ctx = ctxFor(a);

		await applyActions(
			[
				{
					type: "createLocalFolder",
					id: "dddd",
					parent: { newLocal: "" },
					name: "Dir",
				},
			],
			ctx,
		);

		expect(raw(a, "Dir")).toBe("I am a file\n");
		expect(existsSync(join(a.dir, "Dir (2)"))).toBe(true);
		expect(a.state.entries["dddd"]!.path).toBe("Dir (2)");
	});

	it("createLocalFolder keeps the plain name when nothing is in the way", async () => {
		const { a } = setup();
		const ctx = ctxFor(a);

		await applyActions(
			[
				{
					type: "createLocalFolder",
					id: "dddd",
					parent: { newLocal: "" },
					name: "Dir",
				},
			],
			ctx,
		);

		expect(existsSync(join(a.dir, "Dir"))).toBe(true);
		expect(a.state.entries["dddd"]!.path).toBe("Dir");
		expect(ctx.report.warnings).toEqual([]);
	});
});
