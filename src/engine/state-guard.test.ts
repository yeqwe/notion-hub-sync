// An unreadable state file must never be silently treated as "first run".
// Doing so re-downloads the whole vault (tens of minutes on mobile) and the
// save at the end of that round is interrupted the same way — the loop this
// guard exists to break.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { fileExists, makeDevice } from "../../test-support/device";

describe("unreadable sync state", () => {
	it("an empty base with a flagged state problem is refused, not re-pulled", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		a.write("Home.md", "hello\n");
		await a.sync(); // remote now holds one note

		// a second device that cannot read its record
		const b = makeDevice(fake, rootId, "b");
		b.deps.stateProblem = {
			kind: "corrupt",
			detail: "Unexpected end of JSON input",
			bytes: 137,
		};
		const r = await b.sync();

		expect(r.failed).toBe(1);
		expect(r.created).toBe(0);
		expect(r.failures[0]).toContain("sync state unreadable");
		expect(r.failures[0]).toContain("Unexpected end of JSON input");
		// nothing was pulled
		expect(fileExists(b, "Home.md")).toBe(false);
		// and nothing was pushed from the empty side either: the whole-vault
		// re-pull never started, so the vault stayed empty
		const titles = [...fake.pages.values()]
			.filter((p) => !p.inTrash)
			.map((p) => p.title);
		expect(titles.filter((t) => t === "Home").length).toBe(1);
		expect(fileExists(b, "Home.md")).toBe(false);
	});

	it("a state problem with real entries is not blocked", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		a.write("Home.md", "hello\n");
		await a.sync();

		// the flag only matters when there is no base to plan against
		a.deps.stateProblem = {
			kind: "corrupt",
			detail: "stale",
			bytes: 1,
		};
		a.write("Home.md", "hello again\n");
		const r = await a.sync();
		expect(r.failed).toBe(0);
		expect(r.updated).toBeGreaterThan(0);
	});
});
