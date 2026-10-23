import { describe, expect, it } from "vitest";
import { plan } from "./plan";
import type {
	Action,
	BaseNode,
	Kind,
	LocalAdded,
	ParentRef,
	PlanInput,
	RemoteAdded,
	Side,
} from "./types";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function b(
	id: string,
	kind: Kind = "note",
	parentId = "root",
	name = `${id}.md`,
	sha: string | null = SHA_A,
): BaseNode {
	return { id, kind, parentId, name, sha };
}

function side(
	parent: ParentRef,
	name: string,
	sha: string | null = SHA_A,
): Side {
	return { deleted: false, parent, name, sha };
}

const DEL: Side = { deleted: true };
const P = (id: string): ParentRef => ({ id });

function input(over: Partial<PlanInput> = {}): PlanInput {
	return {
		base: {},
		local: {},
		remote: {},
		localAdded: [],
		remoteAdded: [],
		pathOf: (parent, name) => {
			const dir =
				"id" in parent
					? parent.id === "root"
						? ""
						: `P${parent.id}/`
					: "newLocal" in parent
						? `${parent.newLocal}/`
						: `N/${parent.newRemote}/`;
			return dir + name;
		},
		...over,
	};
}

function one(id: string, kind: Kind = "note"): string {
	return kind === "note" ? `${id}.md` : id;
}

describe("plan: deletion matrix", () => {
	it("1. both deleted → forget", () => {
		const node = b("x");
		const acts = plan(
			input({ base: { x: node }, local: { x: DEL }, remote: { x: DEL } }),
		);
		expect(acts).toEqual([{ type: "forget", id: "x" }]);
	});

	it("2a. local deleted, remote absent → trashRemote", () => {
		const acts = plan(
			input({ base: { x: b("x") }, local: { x: DEL } }),
		);
		expect(acts).toEqual([{ type: "trashRemote", id: "x" }]);
	});

	it("2b. local deleted, remote only moved → trashRemote", () => {
		const acts = plan(
			input({
				base: { x: b("x") },
				local: { x: DEL },
				remote: { x: side(P("elsewhere"), "x.md", SHA_A) },
			}),
		);
		expect(acts).toEqual([{ type: "trashRemote", id: "x" }]);
	});

	it("3. local deleted, remote changed → restoreLocal", () => {
		const acts = plan(
			input({
				base: { x: b("x") },
				local: { x: DEL },
				remote: { x: side(P("root"), "x.md", SHA_B) },
			}),
		);
		expect(acts).toEqual([{ type: "restoreLocal", id: "x" }]);
	});

	it("4a. remote deleted, local absent → trashLocal", () => {
		const acts = plan(
			input({ base: { x: b("x") }, remote: { x: DEL } }),
		);
		expect(acts).toEqual([{ type: "trashLocal", id: "x" }]);
	});

	it("4b. remote deleted, local only moved → trashLocal", () => {
		const acts = plan(
			input({
				base: { x: b("x") },
				local: { x: side(P("elsewhere"), "x.md", SHA_A) },
				remote: { x: DEL },
			}),
		);
		expect(acts).toEqual([{ type: "trashLocal", id: "x" }]);
	});

	it("5. remote deleted, local changed → recreateRemote", () => {
		const acts = plan(
			input({
				base: { x: b("x") },
				local: { x: side(P("root"), "x.md", SHA_B) },
				remote: { x: DEL },
			}),
		);
		expect(acts).toEqual([{ type: "recreateRemote", id: "x" }]);
	});
});

describe("plan: content matrix", () => {
	it("6a. local changed only → pushContent", () => {
		const acts = plan(
			input({
				base: { x: b("x") },
				local: { x: side(P("root"), "x.md", SHA_B) },
			}),
		);
		expect(acts).toEqual([{ type: "pushContent", id: "x" }]);
	});

	it("6b. remote changed only → pullContent", () => {
		const acts = plan(
			input({
				base: { x: b("x") },
				remote: { x: side(P("root"), "x.md", SHA_B) },
			}),
		);
		expect(acts).toEqual([{ type: "pullContent", id: "x" }]);
	});

	it("6c. both changed, same sha → converged, no action", () => {
		const acts = plan(
			input({
				base: { x: b("x") },
				local: { x: side(P("root"), "x.md", SHA_B) },
				remote: { x: side(P("root"), "x.md", SHA_B) },
			}),
		);
		expect(acts).toEqual([]);
	});

	it("6d. both changed, differ, note → merge", () => {
		const acts = plan(
			input({
				base: { x: b("x") },
				local: { x: side(P("root"), "x.md", SHA_B) },
				remote: { x: side(P("root"), "x.md", SHA_C) },
			}),
		);
		expect(acts).toEqual([{ type: "merge", id: "x" }]);
	});

	it("6e. both changed, differ, file → conflictCopy", () => {
		const node = b("x", "file", "root", "pic.png");
		const acts = plan(
			input({
				base: { x: node },
				local: { x: side(P("root"), "pic.png", SHA_B) },
				remote: { x: side(P("root"), "pic.png", SHA_C) },
			}),
		);
		expect(acts).toEqual([{ type: "conflictCopy", id: "x" }]);
	});
});

describe("plan: location matrix", () => {
	it("7a. local moved only → moveRemote", () => {
		const acts = plan(
			input({
				base: { x: b("x") },
				local: { x: side(P("fold"), "x.md", SHA_A) },
			}),
		);
		expect(acts).toEqual([
			{ type: "moveRemote", id: "x", parent: P("fold"), name: "x.md" },
		]);
	});

	it("7b. remote moved only → moveLocal", () => {
		const acts = plan(
			input({
				base: { x: b("x") },
				remote: { x: side(P("fold"), "x.md", SHA_A) },
			}),
		);
		expect(acts).toEqual([
			{ type: "moveLocal", id: "x", parent: P("fold"), name: "x.md" },
		]);
	});

	it("7c. both moved to the same target → nothing", () => {
		const acts = plan(
			input({
				base: { x: b("x") },
				local: { x: side(P("fold"), "x.md", SHA_A) },
				remote: { x: side(P("fold"), "x.md", SHA_A) },
			}),
		);
		expect(acts).toEqual([]);
	});

	it("7d. both moved to different targets → remote wins", () => {
		const acts = plan(
			input({
				base: { x: b("x") },
				local: { x: side(P("l1"), "x.md", SHA_A) },
				remote: { x: side(P("r1"), "x.md", SHA_A) },
			}),
		);
		expect(acts).toEqual([
			{ type: "moveLocal", id: "x", parent: P("r1"), name: "x.md" },
		]);
	});

	it("7e. rename counts as a move", () => {
		const acts = plan(
			input({
				base: { x: b("x") },
				local: { x: side(P("root"), "renamed.md", SHA_A) },
			}),
		);
		expect(acts).toEqual([
			{
				type: "moveRemote",
				id: "x",
				parent: P("root"),
				name: "renamed.md",
			},
		]);
	});

	it("content + move can both be emitted", () => {
		const acts = plan(
			input({
				base: { x: b("x") },
				local: { x: side(P("fold"), "x.md", SHA_B) },
			}),
		);
		expect(acts).toContainEqual({ type: "pushContent", id: "x" });
		expect(acts).toContainEqual({
			type: "moveRemote",
			id: "x",
			parent: P("fold"),
			name: "x.md",
		});
	});
});

describe("plan: folders", () => {
	const folder = (id: string, parentId = "root", name = id): BaseNode =>
		b(id, "folder", parentId, name, null);

	it("folder deleted locally, empty → trashRemote", () => {
		const acts = plan(
			input({ base: { f: folder("f") }, local: { f: DEL } }),
		);
		expect(acts).toEqual([{ type: "trashRemote", id: "f" }]);
	});

	it("folder deleted locally but a child is restored under it → kept", () => {
		const acts = plan(
			input({
				base: {
					f: folder("f"),
					x: b("x", "note", "f", "x.md"),
				},
				local: { f: DEL, x: DEL },
				remote: { x: side(P("f"), "x.md", SHA_B) },
			}),
		);
		expect(acts).toContainEqual({ type: "restoreLocal", id: "x" });
		expect(acts).not.toContainEqual({ type: "trashRemote", id: "f" });
	});

	it("folder deleted remotely but a local child moved in → kept", () => {
		const acts = plan(
			input({
				base: {
					f: folder("f"),
					x: b("x", "note", "root", "x.md"),
				},
				local: { x: side(P("f"), "x.md", SHA_A) },
				remote: { f: DEL },
			}),
		);
		expect(acts).not.toContainEqual({ type: "trashLocal", id: "f" });
	});

	it("renamed folder does not touch its children", () => {
		const acts = plan(
			input({
				base: {
					f: folder("f"),
					x: b("x", "note", "f", "x.md"),
				},
				remote: { f: side(P("root"), "Renamed", null) },
			}),
		);
		expect(acts).toEqual([
			{
				type: "moveLocal",
				id: "f",
				parent: P("root"),
				name: "Renamed",
			},
		]);
	});
});

describe("plan: added items", () => {
	const la = (
		path: string,
		kind: Kind = "note",
		parent: ParentRef = P("root"),
		name = path,
		sha: string | null = SHA_A,
	): LocalAdded => ({ path, kind, parent, name, sha });
	const ra = (
		id: string,
		kind: Kind = "note",
		parent: ParentRef = P("root"),
		name = `${id}.md`,
		sha: string | null = SHA_A,
	): RemoteAdded => ({ id, kind, parent, name, sha });

	it("same path, same sha → link", () => {
		const acts = plan(
			input({
				localAdded: [la("note.md")],
				remoteAdded: [ra("r1")],
				pathOf: () => "note.md",
			}),
		);
		expect(acts).toEqual([
			{ type: "link", id: "r1", localPath: "note.md", kind: "note" },
		]);
	});

	it("same path, different sha → localConflictCopy + pullNew", () => {
		const acts = plan(
			input({
				localAdded: [la("note.md", "note", P("root"), "note.md", SHA_A)],
				remoteAdded: [
					ra("r1", "note", P("root"), "note.md", SHA_B),
				],
				pathOf: () => "note.md",
			}),
		);
		expect(acts).toEqual([
			{
				type: "localConflictCopy",
				localPath: "note.md",
				conflictsWith: "r1",
			},
			{
				type: "pullNew",
				id: "r1",
				kind: "note",
				parent: P("root"),
				name: "note.md",
			},
		]);
	});

	it("same path folder → link", () => {
		const acts = plan(
			input({
				localAdded: [la("Sub", "folder", P("root"), "Sub", null)],
				remoteAdded: [
					ra("rf", "folder", P("root"), "Sub", null),
				],
				pathOf: () => "Sub",
			}),
		);
		expect(acts).toEqual([
			{ type: "link", id: "rf", localPath: "Sub", kind: "folder" },
		]);
	});

	it("unmatched local note → pushNew; unmatched remote file → pullNew", () => {
		const acts = plan(
			input({
				localAdded: [la("mine.md")],
				remoteAdded: [ra("r9", "file", P("root"), "theirs.bin", SHA_C)],
			}),
		);
		expect(acts).toContainEqual({
			type: "pushNew",
			localPath: "mine.md",
			kind: "note",
			parent: P("root"),
		});
		expect(acts).toContainEqual({
			type: "pullNew",
			id: "r9",
			kind: "file",
			parent: P("root"),
			name: "theirs.bin",
		});
	});

	it("unmatched folders → createRemoteFolder / createLocalFolder", () => {
		const acts = plan(
			input({
				localAdded: [la("LDir", "folder", P("root"), "LDir", null)],
				remoteAdded: [ra("rd", "folder", P("root"), "RDir", null)],
			}),
		);
		expect(acts).toContainEqual({
			type: "createRemoteFolder",
			localPath: "LDir",
			parent: P("root"),
		});
		expect(acts).toContainEqual({
			type: "createLocalFolder",
			id: "rd",
			parent: P("root"),
			name: "RDir",
		});
	});

	it("bootstrap: empty base, both sides populated", () => {
		const acts = plan(
			input({
				localAdded: [la("a.md"), la("D", "folder", P("root"), "D", null)],
				remoteAdded: [ra("r1")],
			}),
		);
		expect(acts.map((a) => a.type).sort()).toEqual([
			"createRemoteFolder",
			"pullNew",
			"pushNew",
		]);
	});
});

describe("plan: ordering", () => {
	it("folder creates are shallow-first; trashes deepest-first; forget last", () => {
		const acts = plan(
			input({
				base: {
					p: b("p", "folder", "root", "p", null),
					c: b("c", "note", "p", "c.md", SHA_A),
				},
				local: { p: DEL, c: DEL },
				remote: {
					g: side(P("root"), "g", null), // folder g remote-deleted? no —
				},
				localAdded: [
					{
						path: "deep/leaf",
						kind: "folder",
						parent: P("root"),
						name: "leaf",
						sha: null,
					},
					{
						path: "deep",
						kind: "folder",
						parent: P("root"),
						name: "deep",
						sha: null,
					},
				],
				pathOf: (parent, name) =>
					("id" in parent ? "" : "") + name,
			}),
		);
		const types = acts.map((a) => a.type);
		// folder creates first, shallowest first
		expect(types.indexOf("createRemoteFolder")).toBe(0);
		expect(acts[0]).toMatchObject({ localPath: "deep" });
		expect(acts[1]).toMatchObject({ localPath: "deep/leaf" });
		// trashes deepest first: c (child) before p (parent)
		const trashIdx = types.lastIndexOf("trashRemote");
		const trashActions = acts.filter((a) => a.type === "trashRemote");
		expect(trashActions[0]).toEqual({ type: "trashRemote", id: "c" });
		expect(trashActions[1]).toEqual({ type: "trashRemote", id: "p" });
		expect(trashIdx).toBeLessThan(types.length);
	});

	it("moves precede links and content ops precede trashes", () => {
		const node = b("x");
		const acts = plan(
			input({
				base: { x: node, y: b("y") },
				local: {
					x: side(P("fold"), "x.md", SHA_B),
					y: DEL,
				},
				remoteAdded: [],
			}),
		);
		const types = acts.map((a) => a.type);
		expect(types.indexOf("moveRemote")).toBeLessThan(
			types.indexOf("pushContent"),
		);
		expect(types.indexOf("pushContent")).toBeLessThan(
			types.indexOf("trashRemote"),
		);
	});
});
