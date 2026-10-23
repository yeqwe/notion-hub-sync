// Empty folders: the shape with no content to compare. A folder carries no
// sha, so every decision about one rests on structure alone 鈥?which is
// exactly were four bugs lived:
//
//  1. trashRemote ran in one flat pool. Trashing a page archives its whole
//     subtree, so a child queued in the same batch got 400 "archived
//     ancestor" and its base entry could never be dropped 鈥?the failure
//     repeated on every round.
//  2. `link` stored an entry without a parentId, so the next round saw a
//     move that never happened and issued moveRemote.
//  3. `link` took the REMOTE kind. A directory could end up recorded as a
//     note, which is a path that cannot exist in a vault.
//  4. Two devices each creating a page for the same new directory left two
//     live pages for one path; every later action then ran twice.

import { describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, type Device } from "../../test-support/device";

function setup() {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a");
	const b = makeDevice(fake, rootId, "b");
	return { fake, rootId, a, b };
}

const livePages = (f: FakeNotion) =>
	[...f.pages.values()].filter((p) => !p.inTrash);

const titled = (f: FakeNotion, title: string) =>
	livePages(f).filter((p) => p.title === title);

/** Every vault path under `dir`, folders suffixed with "/". */
function tree(d: Device): string[] {
	const out: string[] = [];
	const walk = (rel: string) => {
		for (const e of readdirSync(join(d.dir, rel || "."), {
			withFileTypes: true,
		})) {
			const p = rel ? `${rel}/${e.name}` : e.name;
			if (p.split("/").some((s) => s.startsWith("."))) continue;
			if (e.isDirectory()) {
				out.push(`${p}/`);
				walk(p);
			} else out.push(p);
		}
	};
	walk("");
	return out.sort();
}

/** True when another round would have nothing to do. */
function idle(r: { created: number; updated: number; failed: number }) {
	return r.created + r.updated + r.failed === 0;
}

describe("empty folders", () => {
	it("create on one device, appear on the other, then both idle", async () => {
		const { a, b } = setup();
		mkdirSync(join(a.dir, "Empty"));
		mkdirSync(join(a.dir, "Nest", "Inner"), { recursive: true });
		await a.sync();
		await b.sync();
		expect(tree(b)).toEqual(["Empty/", "Nest/", "Nest/Inner/"]);
		expect(idle(await b.sync())).toBe(true);
		expect(idle(await a.sync())).toBe(true);
	});

	it("deleting a folder with empty subfolders leaves nothing behind", async () => {
		const { fake, a } = setup();
		mkdirSync(join(a.dir, "Big", "e1"), { recursive: true });
		mkdirSync(join(a.dir, "Big", "e2", "e3"), { recursive: true });
		a.write("Big/n.md", "n\n");
		await a.sync();
		rmSync(join(a.dir, "Big"), { recursive: true });

		const r = await a.sync();
		// a child trashed after its parent archived the subtree used to fail
		// with "archived ancestor" and retry forever
		expect(r.failures).toEqual([]);
		expect(tree(a)).toEqual([]);
		expect(Object.keys(a.state.entries)).toEqual([]);
		expect(titled(fake, "Big")).toEqual([]);
		expect(idle(await a.sync())).toBe(true);
	});

	it("remote deletion of a folder tree clears the other device", async () => {
		const { fake, a, b } = setup();
		mkdirSync(join(a.dir, "Big", "e1"), { recursive: true });
		mkdirSync(join(a.dir, "Big", "e2", "e3"), { recursive: true });
		a.write("Big/n.md", "n\n");
		await a.sync();
		await b.sync();
		fake.humanTrash(titled(fake, "Big")[0]!.id);

		const r = await b.sync(true);
		expect(r.failures).toEqual([]);
		expect(tree(b)).toEqual([]);
		expect(Object.keys(b.state.entries)).toEqual([]);
		expect(idle(await b.sync())).toBe(true);
	});

	it("same-named folder on both sides links without a phantom move", async () => {
		const { a, b } = setup();
		mkdirSync(join(a.dir, "Shared"));
		await a.sync();
		mkdirSync(join(b.dir, "Shared"));

		// link must record the real parent: an empty parentId made the next
		// round treat the folder as moved and re-issue moveRemote
		await b.sync();
		const entry = Object.values(b.state.entries)[0]!;
		expect(entry.parentId).toBe(b.state.rootPageId);
		expect(entry.kind).toBe("folder");
		expect(idle(await b.sync())).toBe(true);
		expect(tree(b)).toEqual(["Shared/"]);
	});

	it("concurrent creation of the same folder converges to one page", async () => {
		const { fake, a, b } = setup();
		mkdirSync(join(a.dir, "Con"));
		mkdirSync(join(b.dir, "Con"));
		// neither audit can see the other's page yet
		await Promise.all([a.sync(), b.sync()]);
		expect(titled(fake, "Con").length).toBe(2);

		await a.sync();
		await b.sync();
		// A knows only its own page, so it sees B's as a duplicate occupying
		// the same place; B learns about A's the same way. Both entries name
		// the same directory, so whichever page survives, the local folder is
		// there and the other page goes — one page per place from then on.
		expect(titled(fake, "Con").length).toBe(1);
		expect(Object.keys(a.state.entries).length).toBe(1);
		expect(Object.keys(b.state.entries).length).toBe(1);
		expect(Object.keys(a.state.entries)).toEqual(
			Object.keys(b.state.entries),
		);

        // one file inside -> exactly one page, not two
		a.write("Con/f.md", "x\n");
		await a.sync();
		await b.sync();
		expect(titled(fake, "f").length).toBe(1);
		expect(idle(await a.sync())).toBe(true);
		expect(idle(await b.sync())).toBe(true);
	});

	it("a deleted folder is not resurrected by a leftover duplicate page", async () => {
		const { fake, rootId, a } = setup();
		mkdirSync(join(a.dir, "F"));
		await a.sync();
		// an old duplicate page for the same place: exactly the state that
		// made a deleted folder come back on every round — the remote page
		// was treated as "a new folder" and pulled in again
		fake.humanCreatePage(rootId, "F", "📁");

		rmSync(join(a.dir, "F"), { recursive: true });
		const r = await a.sync();
		// both pages go in one round: the base entry (user's deletion) and the
		// leftover duplicate
		expect(r.failures).toEqual([]);
		expect(tree(a)).toEqual([]);
		expect(Object.keys(a.state.entries)).toEqual([]);
		expect(titled(fake, "F")).toEqual([]);
		expect(idle(await a.sync())).toBe(true);
	});

	it("a folder deleted on both sides never comes back", async () => {
		const { fake, a, b } = setup();
		mkdirSync(join(a.dir, "G"));
		await a.sync();
		await b.sync();
		// the remote page is gone AND the user deleted the local folder
		fake.humanTrash(titled(fake, "G")[0]!.id);
		rmSync(join(a.dir, "G"), { recursive: true });

		for (let i = 0; i < 3; i++) {
			expect((await a.sync(true)).failures).toEqual([]);
			expect((await b.sync(true)).failures).toEqual([]);
			expect(tree(a)).toEqual([]);
			expect(tree(b)).toEqual([]);
		}
		expect(titled(fake, "G")).toEqual([]);
		void idle;
	});

	it("a folder that lost its last file stays and does not churn", async () => {
		const { a, b } = setup();
		a.write("F/x.md", "x\n");
		await a.sync();
		await b.sync();
		rmSync(join(a.dir, "F", "x.md"));

		await a.sync();
		await b.sync();
		expect(tree(a)).toEqual(["F/"]);
		expect(tree(b)).toEqual(["F/"]);
		expect(idle(await a.sync())).toBe(true);
		expect(idle(await b.sync())).toBe(true);
	});

	it("rename with and without a hint both converge", async () => {
		for (const withHint of [true, false]) {
			const { fake, a } = setup();
			mkdirSync(join(a.dir, "Old"));
			await a.sync();
			const before = titled(fake, "Old")[0]!.id;
			await a.vault.rename("Old", "New");
			if (withHint) a.state.renameHints = [{ from: "Old", to: "New" }];

			await a.sync();
			expect(tree(a)).toEqual(["New/"]);
			expect(titled(fake, "New").length).toBe(1);
			expect(titled(fake, "Old")).toEqual([]);
			// the hint path keeps the page; the fallback rebuilds it 鈥?either
			// way exactly one page survives and nothing churns afterwards
			expect(titled(fake, "New")[0]!.id === before).toBe(withHint);
			expect(idle(await a.sync())).toBe(true);
		}
	});

	it("an iconless page never turns a directory into a note", async () => {
		const { fake, rootId, b } = setup();
		// a page created by hand in Notion carries no emoji
		fake.humanCreatePage(rootId, "Dir");
		mkdirSync(join(b.dir, "Dir"));

		await b.sync(true);
		const kinds = Object.values(b.state.entries).map((e) => e.kind);
		// `Dir.md` (the page) and `Dir/` (the folder) are different paths 鈥?		// the folder must stay a folder, the page must stay a note file
		expect(kinds.sort()).toEqual(["folder", "note"]);
		expect(tree(b)).toEqual(["Dir.md", "Dir/"]);
		expect(idle(await b.sync())).toBe(true);
	});
});
