// "The local file is gone" only means "the user deleted it" when the file
// was last SEEN in the state the remote already has.
//
// A file that was last observed with edits that never reached Notion is
// different: the remote copy may be the only one left of that work, so the
// disappearance must not trash it. The gate used to accept any entry with a
// `lastSeenAt` stamp, i.e. "we saw it last round" — which is true for a file
// whose push had just failed.

import { describe, expect, it } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice } from "../../test-support/device";

describe("deletion is only propagated for a file that was in sync", () => {
	it("a file last seen with unpushed edits keeps its remote page", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");

		a.write("n.md", "v1\n");
		await a.sync();
		const id = Object.keys(a.state.entries)[0]!;

		// the local edit is never uploaded: the push fails this round
		a.write("n.md", "v2 — only on this device\n");
		fake.failOnce(/\/markdown$/, "PATCH");
		const r1 = await a.sync();
		expect(r1.failed).toBeGreaterThan(0);
		const e = a.state.entries[id]!;
		expect(e.lastSeenMtime).not.toBe(e.localMtime);

		// …and now the file disappears
		unlinkSync(join(a.dir, "n.md"));
		const r2 = await a.sync();

		expect(r2.failed).toBe(0);
		// the page with the last known good content survives
		expect(fake.pages.get(id)?.inTrash).toBeFalsy();
		expect(a.state.entries[id]).toBeTruthy();
	});

	it("a file that WAS in sync is still deleted remotely", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");

		a.write("n.md", "v1\n");
		await a.sync();
		const id = Object.keys(a.state.entries)[0]!;

		unlinkSync(join(a.dir, "n.md"));
		const r = await a.sync();

		expect(r.failed).toBe(0);
		expect(fake.pages.get(id)?.inTrash).toBe(true);
	});
});
