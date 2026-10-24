// A note that grows child pages in Notion: the children must land in a
// sibling DIRECTORY named after the note (`a/b/`), never inside the note's
// own path (`a/b.md/` — not a legal vault directory).

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, type Device } from "../../test-support/device";
import type { ConfigSyncSettings } from "../config/filter";

const noConfig = (): ConfigSyncSettings => ({
	enabled: false,
	app: false,
	appearance: false,
	appearanceData: false,
	hotkey: false,
	corePlugin: false,
	corePluginData: false,
	communityPlugin: false,
	communityPluginData: false,
});

const has = (d: Device, p: string): boolean =>
	existsSync(join(d.dir, ...p.split("/")));

function setup() {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
	const b = makeDevice(fake, rootId, "b", { configSync: noConfig() });
	return { fake, rootId, a, b };
}

describe("child pages of a note", () => {
	it("a human move of an existing page under a note lands in a sibling dir", async () => {
		const { fake, a, b } = setup();
		a.write("a/b.md", "parent body\n");
		a.write("other.md", "moved child\n");
		await a.sync();
		await b.sync();

		const noteId = Object.entries(a.state.entries).find(
			([, e]) => e.path === "a/b.md",
		)![0];
		const childId = Object.entries(b.state.entries).find(
			([, e]) => e.path === "other.md",
		)![0];
		fake.humanMove(childId, noteId);

		await b.sync(true);
		expect(has(b, "a/b.md")).toBe(true);
		expect(has(b, "a/b/other.md")).toBe(true);
		expect(has(b, "a/b.md/other.md")).toBe(false);
	});

	it("a page created by hand under a note pulls into a sibling dir", async () => {
		const { fake, a, b } = setup();
		a.write("a/b.md", "parent body\n");
		await a.sync();
		await b.sync();
		const noteId = Object.entries(a.state.entries).find(
			([, e]) => e.path === "a/b.md",
		)![0];

		const newId = fake.humanCreatePage(noteId, "fresh");
		fake.humanEdit(newId, "fresh body\n");

		await b.sync(true);
		expect(has(b, "a/b/fresh.md")).toBe(true);
		expect(has(b, "a/b.md/fresh.md")).toBe(false);
	});

	it("a child page under a note is reported as a round warning", async () => {
		const { fake, a, b } = setup();
		a.write("a/b.md", "parent body\n");
		await a.sync();
		await b.sync();
		const noteId = Object.entries(a.state.entries).find(
			([, e]) => e.path === "a/b.md",
		)![0];
		fake.humanCreatePage(noteId, "fresh");

		const r = await b.sync(true);
		expect(
			r.warnings.some((w) => w.includes("b") && w.includes("child page")),
		).toBe(true);
	});

	it("a note's own body is untouched by the child landing in a dir", async () => {
		const { fake, a, b } = setup();
		a.write("a/b.md", "parent body\n");
		await a.sync();
		await b.sync();
		const noteId = Object.entries(a.state.entries).find(
			([, e]) => e.path === "a/b.md",
		)![0];
		const newId = fake.humanCreatePage(noteId, "fresh");
		fake.humanEdit(newId, "fresh body\n");

		await b.sync(true);
		expect(b.read("a/b.md")).toBe("parent body\n");
		expect(b.read("a/b/fresh.md")).toBe("fresh body\n");
	});

	it("the note keeps syncing normally while it owns child pages", async () => {
		const { fake, a, b } = setup();
		a.write("a/b.md", "v1\n");
		await a.sync();
		await b.sync();
		const noteId = Object.entries(a.state.entries).find(
			([, e]) => e.path === "a/b.md",
		)![0];
		const childId = fake.humanCreatePage(noteId, "fresh");
		fake.humanEdit(childId, "child v1\n");
		await b.sync(true);

		// the note's own body still round-trips in both directions
		b.write("a/b.md", "v2 from B\n");
		await b.sync();
		await a.sync();
		expect(a.read("a/b.md")).toBe("v2 from B\n");

		// and the child still follows its parent's identity (incremental
		// round — a full round only audits structure, not content)
		fake.humanEdit(childId, "child v2\n");
		await b.sync();
		expect(b.read("a/b/fresh.md")).toBe("child v2\n");
	});

	it("settles: repeated rounds keep the note AND the dir, no churn", async () => {
		const { fake, a, b } = setup();
		a.write("a/b.md", "parent body\n");
		await a.sync();
		await b.sync();
		const noteId = Object.entries(a.state.entries).find(
			([, e]) => e.path === "a/b.md",
		)![0];
		fake.humanCreatePage(noteId, "fresh");

		await b.sync(true);
		const first = b.state.entries;
		const notePath = Object.entries(first).find(
			([id]) => id === noteId,
		)![1].path;
		const childPath = Object.values(first).find((e) =>
			e.path.endsWith("fresh.md"),
		)!.path;

		// three more rounds must not move anything
		for (let i = 0; i < 3; i++) {
			const r = await b.sync(true);
			expect(r.created + r.updated + r.failed).toBe(0);
		}
		expect(b.state.entries[noteId]!.path).toBe(notePath);
		expect(notePath).toBe("a/b.md");
		expect(childPath).toBe("a/b/fresh.md");
		expect(b.read("a/b.md")).toBe("parent body\n");
	});
});

describe("a page parented by a block", () => {
	it("keeps its base parent — not treated as moved to the vault root", async () => {
		const { fake, a, b } = setup();
		a.write("dir/note.md", "body\n");
		await a.sync();
		await b.sync();
		const id = Object.entries(b.state.entries).find(
			([, e]) => e.path === "dir/note.md",
		)![0];

		// GET /pages/{id} now reports `parent: { type: "block_id" }` —
		// pageInfo surfaces that as `parent: null`. The incremental search
		// (structure scan off) makes the page an evaluate candidate.
		fake.humanReparentUnderBlock(id);
		fake.humanEdit(id, "body edited in notion\n");
		b.deps.engine.scanStructureEveryRound = false;

		const r = await b.sync();
		expect(r.failed).toBe(0);
		// the buggy read: parent null → root → moveLocal "note.md" to /
		expect(has(b, "dir/note.md")).toBe(true);
		expect(has(b, "note.md")).toBe(false);
		// and the content evaluation still ran (the edit was pulled)
		expect(b.read("dir/note.md")).toBe("body edited in notion\n");
	});
});
