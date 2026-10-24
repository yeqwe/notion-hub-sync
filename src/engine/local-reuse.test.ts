// The local snapshot's reuse heuristic (`mtime+size match ⇒ sha unchanged`)
// is a PERFORMANCE shortcut. This file pins down the two directions it must
// not be trusted in, and the one it legitimately covers.
//
// Hashing every file every round would be unaffordable on a phone (1000 files
// ≈ 11 minutes at Notion's 3 req/s just for the comparisons), so the shortcut
// stays — but it may only ever say "probably unchanged", never "definitely
// changed": a file that fails the test is re-hashed and compared by content.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice } from "../../test-support/device";

describe("local snapshot reuse heuristic", () => {
	it("an unchanged file with a new mtime is still 'unchanged'", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		a.write("n.md", "same bytes\n");
		await a.sync();

		// Touch without changing content: mtime moves, size stays.
		await new Promise((r) => setTimeout(r, 20));
		a.write("n.md", "same bytes\n");

		const r = await a.sync();
		expect(r.updated).toBe(0);
		expect(r.created).toBe(0);
	});

	it("a different size is always re-hashed, never assumed changed", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		a.write("n.md", "short\n");
		await a.sync();
		const id = Object.keys(a.state.entries)[0]!;
		const before = a.state.entries[id]!.srcSha;

		// Different bytes, different size → hashed → pushed.
		a.write("n.md", "a much longer body\n");
		const r = await a.sync();
		expect(r.updated).toBe(1);
		expect(a.state.entries[id]!.srcSha).not.toBe(before);
	});

	it("an untouched file is never re-uploaded across many rounds", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		a.write("n.md", "stable\n");
		await a.sync();
		for (let i = 0; i < 5; i++) {
			const r = await a.sync();
			expect(r.updated + r.created).toBe(0);
		}
	});
});
