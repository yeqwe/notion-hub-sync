import { describe, expect, it } from "vitest";
import { RenameTracker } from "../sync/rename-tracker";
import { snapshotLocal } from "./local";
import { emptyState, type SyncState } from "../sync/state";
import type { VaultFile, VaultIO } from "../sync/vault-io";
import { sha256Hex } from "../sync/hashes";

function fakeVault(
	files: Record<string, string>,
	folders: string[] = [],
	mtimes: Record<string, number> = {},
): VaultIO & { reads: string[] } {
	const reads: string[] = [];
	const vf: VaultFile[] = Object.keys(files).map((p) => ({
		path: p,
		size: new TextEncoder().encode(files[p]!).byteLength,
		mtime: mtimes[p] ?? 1000,
	}));
	return {
		reads,
		list: async () => ({ files: vf, folders }),
		readText: async (p) => {
			reads.push(p);
			return files[p] ?? "";
		},
		readBinary: async (p) => {
			reads.push(p);
			return new TextEncoder().encode(files[p] ?? "")
				.buffer as ArrayBuffer;
		},
		writeText: async () => {},
		writeBinary: async () => {},
		mkdirp: async () => {},
		exists: async (p) => p in files || folders.includes(p),
		stat: async (p) =>
			p in files
				? { size: files[p]!.length, mtime: mtimes[p] ?? 1000 }
				: null,
		rename: async () => {},
		trash: async () => {},
		renames: new RenameTracker(),
		writes: new RenameTracker(),
	};
}

function stateWith(
	entries: SyncState["entries"],
	renameHints: SyncState["renameHints"] = [],
): SyncState {
	return { ...emptyState("root"), entries, renameHints };
}

const folder = (path: string, parentId = "root") => ({
	path,
	kind: "folder" as const,
	notionTitle: path.split("/").pop()!,
	parentId,
});
const note = (path: string, parentId = "root", extra = {}) => ({
	path,
	kind: "note" as const,
	notionTitle: path.split("/").pop()!.replace(/\.md$/, ""),
	parentId,
	srcSha: "sha-" + path,
	localHash: "sha-" + path,
	...extra,
});

describe("snapshotLocal", () => {
	it("applies folder rename hints as prefix remaps", async () => {
		const state = stateWith(
			{
				f1: folder("Dir"),
				n1: note("Dir/Sub.md", "f1"),
			},
			[{ from: "Dir", to: "Dir2" }],
		);
		const v = fakeVault({ "Dir2/Sub.md": "x" }, ["Dir2"]);
		const snap = await snapshotLocal(v, state);
		expect(snap.local["f1"]).toMatchObject({
			deleted: false,
			name: "Dir2",
		});
		expect(snap.local["n1"]).toMatchObject({ deleted: false });
		expect(snap.pathOf.get("n1")).toBe("Dir2/Sub.md");
	});

	it("reuses sha when mtime/size unchanged (no read)", async () => {
		const state = stateWith({
			n1: note("A.md", "root", {
				srcSha: "cached",
				localMtime: 1000,
				localSize: 1,
			}),
		});
		const v = fakeVault({ "A.md": "x" });
		const snap = await snapshotLocal(v, state);
		expect(snap.local["n1"]).toMatchObject({ deleted: false, sha: "cached" });
		expect(v.reads).toEqual([]);
	});

	it("rehashes when mtime changed", async () => {
		const state = stateWith({
			n1: note("A.md", "root", {
				srcSha: await sha256Hex(new TextEncoder().encode("x")),
				localMtime: 500,
				localSize: 1,
			}),
		});
		const v = fakeVault({ "A.md": "x" });
		const snap = await snapshotLocal(v, state);
		expect(v.reads).toContain("A.md");
	});

	it("detects renames via matching sha (fallback)", async () => {
		const content = new TextEncoder().encode("body");
		const sha = await sha256Hex(content);
		const state = stateWith({
			n1: note("Old.md", "root", { srcSha: sha, localHash: sha }),
		});
		const v = fakeVault({ "Renamed.md": "body" });
		const snap = await snapshotLocal(v, state);
		expect(snap.local["n1"]).toMatchObject({
			deleted: false,
			name: "Renamed.md",
		});
		expect(snap.localAdded).toEqual([]);
	});

	it("reports new files/folders as localAdded", async () => {
		const state = stateWith({});
		const v = fakeVault({ "New.md": "n", "F/x.bin": "b" }, ["F"]);
		const snap = await snapshotLocal(v, state);
		const kinds = Object.fromEntries(
			snap.localAdded.map((a) => [a.path, a.kind]),
		);
		expect(kinds).toEqual({
			F: "folder",
			"F/x.bin": "file",
			"New.md": "note",
		});
	});
});
