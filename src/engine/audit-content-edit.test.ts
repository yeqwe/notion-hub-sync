// Regression: a content edit must survive a full audit.
//
// Bug (fixed): the structural audit (search scan + walkTree fallback) only
// compares parent/name, but stamped entry.remoteEdited for every in-tree
// entry. The next incremental round's search gate
// (`entry.remoteEdited === last_edited_time` -> skip) then treated the page
// as already evaluated and never pulled the new content. With round-robin
// at 0 the edit was lost permanently.
//
// These tests use FakeNotion.humanEdit, which bumps last_edited_time — the
// behaviour measured on real Notion (a content edit DOES move the field to
// a new minute; probe-m4's "edit-bumps-last_edited" FAIL was a rounding
// false-negative, all ops + the 150s wait stayed inside one minute bucket).

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice } from "../../test-support/device";
import { defaultConfigSync } from "../config/filter";

function setup(n: number, rr: number, fullAuditHours = 10_000) {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a", {
		roundRobinPerRound: rr,
		fullAuditHours,
		configSync: defaultConfigSync(),
	});
	for (let i = 0; i < n; i++) {
		a.write(`n${String(i).padStart(2, "0")}.md`, `# n${i}\noriginal\n`);
	}
	return { fake, a };
}

function idOf(d: ReturnType<typeof setup>["a"], path: string): string {
	const hit = Object.entries(d.state.entries).find(([, e]) => e.path === path);
	if (!hit) throw new Error(`no entry for ${path}`);
	return hit[0];
}

describe("a content edit survives a full audit", () => {
	it("edit -> FULL sync -> later incrementals still pull it (RR=0)", async () => {
		const { fake, a } = setup(8, 0);
		await a.sync();
		await a.sync();
		const id = idOf(a, "n05.md");

		fake.humanEdit(id, "# n05\nHUMAN EDIT\n");
		fake.now += 600_000;

		// Full sync: the audit sees the structure is unchanged and does not
		// pull content itself (round-robin is off) — so nothing is updated.
		const rFull = await a.sync(true);
		expect(a.read("n05.md")).not.toContain("HUMAN EDIT");
		expect(rFull.updated).toBe(0);

		// The audit must NOT have marked the page as evaluated.
		const stampedAt = a.state.entries[id]!.remoteEdited;
		const pageTs = new Date(fake.pages.get(id)!.lastEdited).toISOString();
		expect(stampedAt).not.toBe(pageTs);

		// The next incremental round detects the edit through /search.
		fake.now += 600_000;
		const rInc = await a.sync();
		expect(rInc.updated).toBe(1);
		expect(a.read("n05.md")).toContain("HUMAN EDIT");
	});

	it("edit -> FULL sync -> incremental pulls it even with RR=0", async () => {
		const { fake, a } = setup(8, 0);
		await a.sync();
		await a.sync();
		const id = idOf(a, "n00.md");

		fake.humanEdit(id, "# n00\nEDITED\n");
		fake.now += 600_000;
		await a.sync(true); // audit
		fake.now += 600_000;

		const counts = [] as number[];
		for (let i = 0; i < 3; i++) {
			counts.push((await a.sync()).updated);
			fake.now += 600_000;
		}
		expect(a.read("n00.md")).toContain("EDITED");
		// exactly one round does the pull, the rest are idle
		expect(counts.reduce((x, y) => x + y, 0)).toBe(1);
	});

	it("walkTree fallback stamps nothing and loses nothing", async () => {
		// full audit via the tree walk (search fails) must behave the same
		const { fake, a } = setup(4, 0);
		await a.sync();
		await a.sync();
		const id = idOf(a, "n02.md");

		fake.humanEdit(id, "# n02\nWALK EDIT\n");
		fake.now += 600_000;
		// break /search so the audit falls back to walkTree
		fake.failOnce(/^\/search$/, "POST");
		await a.sync(true);

		const pageTs = new Date(fake.pages.get(id)!.lastEdited).toISOString();
		expect(a.state.entries[id]!.remoteEdited).not.toBe(pageTs);

		fake.now += 600_000;
		const r = await a.sync();
		expect(a.read("n02.md")).toContain("WALK EDIT");
		expect(r.updated).toBe(1);
	});

	it("an entry that drifted into a system subtree stops hogging round-robin", async () => {
		const { fake, a } = setup(5, 1);
		const journalId = fake.humanCreatePage(
			a.state.rootPageId,
			"🧾 journal",
			"\u{1F9FE}",
		);
		await a.sync();
		await a.sync();
		const victim = idOf(a, "n00.md");
		fake.humanMove(victim, journalId);

		const picked: string[] = [];
		for (let round = 0; round < 5; round++) {
			fake.now += 600_000;
			fake.reqLog.length = 0;
			await a.sync();
			const md = fake.reqLog
				.filter((x) => x.path.endsWith("/markdown"))
				.map((x) => x.path.split("/")[2]!);
			const v = a.state.entries[victim];
			picked.push(v?.checkedAt === undefined ? "never" : String(v.checkedAt));
			// the drifted page must not be re-selected forever
			expect(md).not.toContain(victim);
		}
		// every round still evaluates a real candidate (RR=1 is not starved)
		expect(picked.filter((p) => p === "never")).toHaveLength(0);
	});
});
