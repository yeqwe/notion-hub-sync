// Invariant tests for Notion-side render drift: a page whose GET markdown
// differs from the PATCH response (delayed re-normalization) must not
// produce pullContent/local writes, while a real remote edit with the
// source toggle intact must still be detected.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice } from "../../test-support/device";

const RR_ALL = 50;

/** Drift only the visible part — never inside the source toggle. */
function driftVisible(fn: (s: string) => string) {
	return (md: string) => {
		const i = md.indexOf("<details>");
		const head = i === -1 ? md : md.slice(0, i);
		const tail = i === -1 ? "" : md.slice(i);
		return fn(head) + tail;
	};
}

function entryId(state: { entries: Record<string, unknown> }): string {
	return Object.keys(state.entries)[0]!;
}

describe("render drift vs real edit", () => {
	it("drifted GET after push: zero pulls, local bytes stable, summary repaired", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", {
			roundRobinPerRound: RR_ALL,
		});
		a.write("n0.md", "# t\nbody\n");
		await a.sync();
		const id = entryId(a.state);
		const before = a.read("n0.md");

		// Notion re-renders: trailing spaces (raw visible differs → visSha
		// mismatch; converted form identical → drift, not an edit).
		fake.driftFn = driftVisible((s) => s.replace("body", "body  "));
		fake.driftPages.add(id);

		for (let round = 0; round < 3; round++) {
			const r = await a.sync();
			expect(r.updated).toBe(0);
			expect(r.created).toBe(0);
			expect(a.read("n0.md")).toBe(before);
		}

		// summary VIS was repaired: stored markdown carries the drifted
		// visible's hash
		const e = a.state.entries[id]!;
		const pg = fake.pages.get(id)!;
		expect(pg.markdown).toContain(`visible:${e.visSha}`);
	});

	it("visible edit with toggle intact still pulls the converted form", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", {
			roundRobinPerRound: RR_ALL,
		});
		a.write("n0.md", "# t\nbody\n");
		await a.sync();
		const id = entryId(a.state);

		// simulated human edit keeps the toggle but changes the visible —
		// converted forms differ → real edit → pull
		fake.driftFn = driftVisible((s) => s.replace("body", "EDITED"));
		fake.driftPages.add(id);

		const r = await a.sync();
		expect(r.updated).toBe(1);
		expect(a.read("n0.md")).toContain("EDITED");
	});

	it("humanEdit (toggle discarded) still pulls", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", {
			roundRobinPerRound: RR_ALL,
		});
		a.write("n0.md", "# t\nbody\n");
		await a.sync();
		fake.humanEdit(entryId(a.state), "# t\nhuman wrote this\n");

		const r = await a.sync();
		expect(r.updated).toBe(1);
		expect(a.read("n0.md")).toContain("human wrote this");
	});

	it("drifted pages on second device pull losslessly", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", {
			roundRobinPerRound: RR_ALL,
		});
		const b = makeDevice(fake, rootId, "b", {
			roundRobinPerRound: RR_ALL,
		});
		a.write("n0.md", "# t\nbody with _underscores_\n");
		await a.sync();

		// every page drifts once before B's first pull — B must still get
		// the exact source bytes, not the lossy conversion
		fake.driftFn = driftVisible((s) =>
			s.replace("body with", "body   with"),
		);
		for (const p of fake.pages.keys()) fake.driftPages.add(p);
		await b.sync();
		expect(b.read("n0.md")).toBe("# t\nbody with _underscores_\n");
	});
});
