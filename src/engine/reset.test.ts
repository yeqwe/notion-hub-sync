// reset.ts: clearRemote trashes all root children, resetState wipes the
// record, and the next full sync re-uploads everything cleanly.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice } from "../../test-support/device";
import { listChildPages } from "../sync/tree";
import { clearRemote, resetState } from "./reset";

describe("reset helpers", () => {
	it("clearRemote + resetState + full sync re-uploads everything", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		a.write("F/a.md", "a\n");
		a.write("b.md", "b\n");
		await a.sync();

		// clearRemote trashes every direct child (incl. system pages)
		const before = await listChildPages(a.deps.client, rootId);
		const n = await clearRemote({ client: a.deps.client, state: a.deps.state });
		expect(n).toBe(before.length);
		expect(n).toBeGreaterThan(0);
		for (const c of before) {
			expect(
				fake.pages.get(c.id.replace(/-/g, "").toLowerCase())?.inTrash ??
					fake.pages.get(c.id)?.inTrash,
			).toBe(true);
		}
		expect((await listChildPages(a.deps.client, rootId)).length).toBe(0);

		// resetState keeps only version/rootPageId + empty entries
		resetState(a.deps.state);
		expect(Object.keys(a.deps.state).sort()).toEqual(
			["entries", "rootPageId", "version"].sort(),
		);
		expect(a.deps.state.entries).toEqual({});

		// a following full sync re-uploads everything, exactly once
		const r = await a.sync(true);
		expect(r.failed).toBe(0);
		expect(r.conflictCopies).toEqual([]);
		const seen = new Set<string>();
		for (const p of fake.pages.values()) {
			if (p.inTrash) continue;
			const key = `${p.parentId}|${p.title}`;
			expect(seen.has(key)).toBe(false);
			seen.add(key);
		}
		const paths = Object.values(a.deps.state.entries).map((e) => e.path);
		for (const p of ["F", "F/a.md", "b.md"]) {
			expect(paths.filter((x) => x === p).length).toBe(1);
		}
	});
});
