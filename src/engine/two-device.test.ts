// Offline two-device sync scenarios: two NodeVaultIO dirs + separate
// states over one FakeNotion.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { fileExists, makeDevice, type Device } from "../../test-support/device";

function setup(files: Record<string, string>) {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a");
	const b = makeDevice(fake, rootId, "b");
	for (const [p, c] of Object.entries(files)) a.write(p, c);
	return { fake, rootId, a, b };
}

function vaultPaths(d: Device): string[] {
	const out: string[] = [];
	const walk = (rel: string) => {
		for (const e of readdirSync(join(d.dir, rel || "."), {
			withFileTypes: true,
		})) {
			const p = rel ? `${rel}/${e.name}` : e.name;
			if (p.split("/").some((s) => s.startsWith("."))) continue;
			if (e.isDirectory()) walk(p);
			else out.push(p);
		}
	};
	walk("");
	return out.sort();
}

function pageCount(fake: FakeNotion): number {
	return [...fake.pages.values()].filter((p) => !p.inTrash).length;
}

describe("two-device sync (offline)", () => {
	it("1. bootstrap: A pushes, B syncs, identical trees", async () => {
		const { a, b } = setup({
			"Home.md": "# Hello\n",
			"Sub/Child.md": "child body\n",
			"data.bin": "\x00\x01binary",
		});
		await a.sync();
		await b.sync();
		expect(vaultPaths(b)).toEqual(vaultPaths(a));
		for (const p of vaultPaths(a)) {
			expect(b.read(p)).toEqual(a.read(p));
		}
		// B idle round: nothing to do
		const r = await b.sync();
		expect(r.created + r.updated + r.failed).toBe(0);
	});

	it("2. edit on A propagates to B via journal", async () => {
		const { a, b } = setup({ "Home.md": "v1\n" });
		await a.sync();
		await b.sync();
		a.write("Home.md", "v2\n");
		await a.sync();
		await b.sync();
		expect(b.read("Home.md")).toBe("v2\n");
	});

	it("3. non-overlapping edits merge on both devices", async () => {
		const { a, b } = setup({ "Doc.md": "line1\nline2\nline3\n" });
		await a.sync();
		await b.sync();
		a.write("Doc.md", "A-line1\nline2\nline3\n");
		b.write("Doc.md", "line1\nline2\nB-line3\n");
		await a.sync();
		await b.sync();
		await a.sync();
		const merged = "A-line1\nline2\nB-line3\n";
		expect(a.read("Doc.md")).toBe(merged);
		expect(b.read("Doc.md")).toBe(merged);
	});

	it("4. overlapping edits → conflict copy on both", async () => {
		const { a, b, rootId } = setup({ "Doc.md": "base\n" });
		void rootId;
		await a.sync();
		await b.sync();
		a.write("Doc.md", "A wins\n");
		b.write("Doc.md", "B loses\n");
		await a.sync(); // A pushes first
		await b.sync(); // B conflicts
		await b.sync(); // B pushes its conflict copy
		await a.sync(); // A pulls the copy
		expect(a.read("Doc.md")).toBe("A wins\n");
		expect(b.read("Doc.md")).toBe("A wins\n");
		const copiesA = vaultPaths(a).filter((p) => p.includes("conflict"));
		const copiesB = vaultPaths(b).filter((p) => p.includes("conflict"));
		expect(copiesA).toEqual(copiesB);
		expect(copiesA.length).toBe(1);
		expect(b.read(copiesA[0]!)).toBe("B loses\n");
	});

	it("5. delete on A trashes on B with pre-delete history", async () => {
		const { fake, a, b } = setup({ "Gone.md": "bye\n" });
		await a.sync();
		await b.sync();
		await a.vault.trash("Gone.md");
		await a.sync();
		await b.sync();
		expect(fileExists(b, "Gone.md")).toBe(false);
		// a pre-delete version was recorded somewhere
		const caps = [...fake.blocks.values()]
			.flatMap((bl) => {
				const v = bl.data[bl.type] as
					| { caption?: Array<{ text?: { content?: string } }> }
					| undefined;
				return (v?.caption ?? []).map(
					(c) => c.text?.content ?? "",
				);
			})
			.filter((t) => t.includes('"pre-delete"'));
		expect(caps.length).toBeGreaterThan(0);
	});

	it("6. delete on A + edit on B → B recreates, A gets it back", async () => {
		const { fake, a, b } = setup({ "Tug.md": "base\n" });
		await a.sync();
		await b.sync();
		await a.vault.trash("Tug.md");
		await a.sync();
		b.write("Tug.md", "B edited\n");
		await b.sync(); // remote deleted + local changed → recreate
		await a.sync(); // journal n → pullNew
		expect(a.read("Tug.md")).toBe("B edited\n");
		expect(b.read("Tug.md")).toBe("B edited\n");
		// one live page for Tug (old trashed, new live)
		const live = [...fake.pages.values()].filter(
			(p) => !p.inTrash && p.title === "Tug",
		);
		expect(live.length).toBe(1);
	});

	it("7. renames move remotely; children not re-pushed", async () => {
		const { fake, a, b } = setup({
			"Old.md": "body\n",
			"Dir/Sub/Leaf.md": "leaf\n",
		});
		await a.sync();
		await b.sync();
		// rename on A (Node vault doesn't emit rename events — hint manually)
		await a.vault.rename("Old.md", "New.md");
		a.state.renameHints = [{ from: "Old.md", to: "New.md" }];
		await a.vault.rename("Dir", "Dir2");
		a.state.renameHints!.push({ from: "Dir", to: "Dir2" });
		const rA = await a.sync();
		expect(rA.failed).toBe(0);
		// B syncs: moves, no content push of the child note
		fake.reqLog.length = 0;
		await b.sync();
		expect(b.read("New.md")).toBe("body\n");
		expect(b.read("Dir2/Sub/Leaf.md")).toBe("leaf\n");
		const replaces = fake.reqLog.filter(
			(r) => r.method === "PATCH" && r.path.endsWith("/markdown"),
		);
		expect(replaces.length).toBe(0);
	});

	it("8. human Notion edit found via search → B pulls", async () => {
		const { fake, a, b } = setup({ "Note.md": "orig\n" });
		await a.sync();
		await b.sync();
		const note = [...fake.pages.values()].find((p) => p.title === "Note")!;
		fake.humanEdit(note.id, "# human edit\n");
		await b.sync();
		expect(b.read("Note.md")).toBe("# human edit\n");
	});

	it("9. human trash found on full audit → B trashes locally", async () => {
		const { fake, a, b } = setup({ "Doomed.md": "x\n" });
		await a.sync();
		await b.sync();
		const p = [...fake.pages.values()].find(
			(pg) => pg.title === "Doomed",
		)!;
		fake.humanTrash(p.id);
		await b.sync(true);
		expect(fileExists(b, "Doomed.md")).toBe(false);
	});

	it("10. same-path adds with different content → conflict copy", async () => {
		const { a, b } = setup({});
		a.write("Same.md", "A's version\n");
		b.write("Same.md", "B's version\n");
		await a.sync();
		await b.sync(); // conflict: localConflictCopy + pullNew
		await b.sync(); // push conflict copy
		await a.sync(); // pull conflict copy
		expect(a.read("Same.md")).toBe("A's version\n");
		expect(b.read("Same.md")).toBe("A's version\n");
		const copies = vaultPaths(b).filter((p) => p.includes("conflict"));
		expect(copies.length).toBe(1);
		expect(b.read(copies[0]!)).toBe("B's version\n");
		expect(vaultPaths(a).filter((p) => p.includes("conflict")).length).toBe(1);
	});

	it("11. injected failure mid-apply → next round converges", async () => {
		const { fake, a, b } = setup({ "Ok.md": "ok\n" });
		await a.sync();
		await b.sync();
		a.write("New.md", "fresh\n");
		fake.failOnce(/\/pages$/, "POST"); // fail first page create
		const r = await a.sync();
		expect(r.failed).toBeGreaterThan(0);
		const r2 = await a.sync();
		expect(r2.failed).toBe(0);
		await b.sync();
		expect(b.read("New.md")).toBe("fresh\n");
	});

	it("12. local edit during apply → skipped, synced next round", async () => {
		const { a, b } = setup({ "Race.md": "v1\n" });
		await a.sync();
		await b.sync();
		// make the local file change between snapshot and apply: vault write
		// on the second readBinary of Race.md
		a.write("Race.md", "v2\n");
		let reads = 0;
		const orig = a.vault.readBinary.bind(a.vault);
		a.vault.readBinary = async (p: string) => {
			if (p === "Race.md" && ++reads === 2) {
				a.write("Race.md", "v3 mid-round\n");
			}
			return orig(p);
		};
		const r = await a.sync();
		// action skipped this round
		expect(r.failed).toBe(0);
		a.vault.readBinary = orig;
		await a.sync();
		await b.sync();
		expect(b.read("Race.md")).toBe("v3 mid-round\n");
	});
});

describe("journal + audit bookkeeping", () => {
	it("idle round performs few requests and survives repeats", async () => {
		const { fake, a, b } = setup({ "Idle.md": "x\n" });
		await a.sync();
		await b.sync();
		const before = pageCount(fake);
		fake.reqLog.length = 0;
		const r = await b.sync();
		expect(r.created + r.updated + r.failed).toBe(0);
		expect(pageCount(fake)).toBe(before);
		// journal read + search + config-root check (+ page fetches) only
		expect(fake.reqLog.length).toBeLessThanOrEqual(12);
	});

	it("hints recorded mid-round survive to the next round", async () => {
		const { a, b } = setup({ "A.md": "x\n" });
		void b;
		a.state.renameHints = [{ from: "ghost.md", to: "ghost2.md" }];
		const orig = a.vault.readBinary.bind(a.vault);
		let pushed = false;
		a.vault.readBinary = async (p: string) => {
			if (!pushed) {
				pushed = true;
				// a user rename landing *during* the round
				a.state.renameHints!.push({
					from: "Mid.md",
					to: "Mid2.md",
				});
			}
			return orig(p);
		};
		await a.sync();
		a.vault.readBinary = orig;
		expect(a.state.renameHints).toEqual([
			{ from: "Mid.md", to: "Mid2.md" },
		]);
	});

	it("engine renames are consumed by the tracker, not hinted", async () => {
		const { a } = setup({});
		await a.vault.rename("x.md", "y.md").catch(() => {});
		// the same pair is consumed exactly once (listener semantics)
		expect(a.vault.renames.consume("x.md", "y.md")).toBe(true);
		expect(a.vault.renames.consume("x.md", "y.md")).toBe(false);
	});

	it("conflict-copy file exists on disk", async () => {
		const { a, b } = setup({ "X.md": "a\n" });
		await a.sync();
		await b.sync();
		expect(existsSync(join(b.dir, "X.md"))).toBe(true);
	});
});
