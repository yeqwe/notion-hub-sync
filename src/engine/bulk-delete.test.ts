// Bulk remote deletion (the "folder deleted in Notion" case): pool the
// trash actions so the local clear takes about as long as the slowest
// file instead of the sum. Request count is unchanged — only the overlap
// is new. The folder's own trash runs last and serially (renaming a
// non-empty dir fails), which is also what used to leave the empty
// directory behind: readBinary on a folder threw, so `localShaCurrent`
// reported "changed" and the action was skipped for good.

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { fileExists, makeDevice } from "../../test-support/device";
import type { RequestFn } from "../notion/client";

const FILES = 8;

async function setup() {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	let inFlight = 0;
	let maxInFlight = 0;
	// only the pre-delete version uploads are counted: they belong to
	// trashLocal alone, so their overlap measures exactly that action's
	// parallelism (the scan phases never touch /file_uploads).
	let versionsInFlight = 0;
	let maxVersionsInFlight = 0;
	const instrumented: RequestFn = async (r) => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		// version uploads are the dominant per-file cost of trashLocal, and
		// their overlap measures exactly that action's parallelism (the scan
		// phases never touch /file_uploads).
		const isVersion = (r.url ?? "").includes("file_uploads");
		if (isVersion) {
			versionsInFlight++;
			maxVersionsInFlight = Math.max(
				maxVersionsInFlight,
				versionsInFlight,
			);
		}
		try {
			await new Promise((res) => setTimeout(res, 1));
			return await fake.request(r);
		} finally {
			inFlight--;
			if (isVersion) versionsInFlight--;
		}
	};
	const a = makeDevice(fake, rootId, "a", { request: instrumented });
	a.deps.engine.deleteGuardThreshold = 0; // no prompt in tests
	for (let i = 0; i < FILES; i++) a.write(`F/n${i}.md`, `note ${i}\n`);
	await a.sync();
	// warm the history infrastructure (container + per-file page) once, so
	// the round under test measures the deletion only
	a.write("F/n0.md", "warm\n");
	await a.sync();
	await a.sync(); // warm: stamps remoteEdited on every entry

	const folder = [...fake.pages.values()].find((p) => p.title === "F")!;
	fake.humanTrash(folder.id); // cascades: F + all note pages
	inFlight = 0;
	maxInFlight = 0;
	versionsInFlight = 0;
	maxVersionsInFlight = 0;
	return { fake, a, peak: () => maxVersionsInFlight };
}

describe("bulk remote deletion", () => {
	it("trashes local files in parallel and converges in one round", async () => {
		const { a, peak } = await setup();
		const r = await a.sync(true);
		expect(r.failures).toEqual([]);
		expect(r.failed).toBe(0);

		for (let i = 0; i < FILES; i++) {
			expect(fileExists(a, `F/n${i}.md`)).toBe(false);
		}
		// trashLocal actions overlapped: a serial group would show 1
		expect(peak()).toBeGreaterThan(1);
		// the folder itself is gone too (used to be skipped silently)
		expect(existsSync(join(a.dir, "F"))).toBe(false);
		expect(
			Object.values(a.state.entries).filter((e) =>
				e.path.startsWith("F"),
			),
		).toEqual([]);

		// nothing left to do: the next round is a no-op
		const r2 = await a.sync();
		expect(r2.created + r2.updated).toBe(0);
	});
});
