// Remote-trashed folder pages: Notion rejects writes under archived
// ancestors, so a still-needed folder must be recreated under a new page
// id and children re-mapped to it.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { fileExists, makeDevice } from "../../test-support/device";

describe("remote-trashed folders", () => {
	it("recreates needed folders under new page ids", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		a.write("F/a.md", "a\n");
		a.write("F/G/b.md", "b\n");
		await a.sync();

		const oldF = [...fake.pages.values()].find((p) => p.title === "F")!;
		const oldG = [...fake.pages.values()].find((p) => p.title === "G")!;
		fake.humanTrash(oldF.id);

		a.write("F/new.md", "new\n");
		a.write("F/G/new2.md", "new2\n");
		const r = await a.sync(true);
		expect(r.failed).toBe(0);
		expect(r.failures).toEqual([]);

		// old pages stay trashed; brand-new replacements exist
		expect(fake.pages.get(oldF.id)!.inTrash).toBe(true);
		expect(fake.pages.get(oldG.id)!.inTrash).toBe(true);
		const liveF = [...fake.pages.values()].filter(
			(p) => p.title === "F" && !p.inTrash,
		);
		expect(liveF.length).toBe(1);
		const liveG = [...fake.pages.values()].filter(
			(p) => p.title === "G" && !p.inTrash && p.parentId === liveF[0]!.id,
		);
		expect(liveG.length).toBe(1);

		// the added files landed under the NEW pages
		const kids = (pid: string) =>
			[...fake.pages.values()]
				.filter((p) => p.parentId === pid && !p.inTrash)
				.map((p) => p.title);
		// note page titles drop the .md suffix
		expect(kids(liveF[0]!.id)).toContain("new");
		expect(kids(liveG[0]!.id)).toContain("new2");

		// unchanged files under the trashed folder were trashed locally
		expect(fileExists(a, "F/a.md")).toBe(false);
		expect(fileExists(a, "F/G/b.md")).toBe(false);
	});
});
