// Bulk local-delete guard: a large remote-driven deletion batch prompts
// before trashing local files; "keep" re-uploads, "cancel" aborts cleanly.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { fileExists, makeDevice } from "../../test-support/device";

const NOTE_COUNT = 12;

async function setup() {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a");
	for (let i = 1; i <= NOTE_COUNT; i++) {
		a.write(`F/n${i}.md`, `note ${i}\n`);
	}
	await a.sync();
	const folder = [...fake.pages.values()].find((p) => p.title === "F")!;
	fake.humanTrash(folder.id); // cascades: F + all 12 note pages
	a.deps.engine.deleteGuardThreshold = 10;
	return { fake, a };
}

function liveChildren(fake: FakeNotion, parentId: string): string[] {
	return [...fake.pages.values()]
		.filter((p) => p.parentId === parentId && !p.inTrash)
		.map((p) => p.title);
}

describe("bulk local-delete guard", () => {
	it('"keep" re-uploads everything and the next round is a no-op', async () => {
		const { fake, a } = await setup();
		const calls: string[][] = [];
		a.deps.confirmLocalDeletes = async (paths) => {
			calls.push(paths);
			return "keep";
		};
		const r = await a.sync(true);
		expect(r.failed).toBe(0);
		expect(calls.length).toBe(1);
		expect(calls[0]!.length).toBe(NOTE_COUNT);
		expect(calls[0]).toContain("F/n1.md");

		// all 12 files still exist locally
		for (let i = 1; i <= NOTE_COUNT; i++) {
			expect(fileExists(a, `F/n${i}.md`)).toBe(true);
		}
		// a new, non-trashed F holds all 12 notes
		const liveF = [...fake.pages.values()].filter(
			(p) => p.title === "F" && !p.inTrash,
		);
		expect(liveF.length).toBe(1);
		expect(liveChildren(fake, liveF[0]!.id).length).toBe(NOTE_COUNT);

		// second sync: no prompt, no actions
		const r2 = await a.sync(true);
		expect(calls.length).toBe(1);
		expect(r2.failed).toBe(0);
		expect(r2.created + r2.updated).toBe(0);
	});

	it('"delete" trashes the local files', async () => {
		const { fake, a } = await setup();
		a.deps.confirmLocalDeletes = async () => "delete";
		const r = await a.sync(true);
		expect(r.failed).toBe(0);
		for (let i = 1; i <= NOTE_COUNT; i++) {
			expect(fileExists(a, `F/n${i}.md`)).toBe(false);
		}
		void fake;
	});

	it('"cancel" aborts, restores state, and asks again next round', async () => {
		const { a } = await setup();
		const before = JSON.parse(JSON.stringify(a.deps.state));
		const calls: string[][] = [];
		a.deps.confirmLocalDeletes = async (paths) => {
			calls.push(paths);
			return "cancel";
		};
		const r = await a.sync(true);
		expect(r.failed).toBe(0);
		expect(calls.length).toBe(1);
		expect(
			r.warnings.some((w) => w.includes("sync cancelled")),
		).toBe(true);

		// local untouched, state identical to before the round
		for (let i = 1; i <= NOTE_COUNT; i++) {
			expect(fileExists(a, `F/n${i}.md`)).toBe(true);
		}
		expect(a.deps.state).toEqual(before);

		// next sync asks again
		await a.sync(true);
		expect(calls.length).toBe(2);
	});

	it("threshold 0 never prompts", async () => {
		const { a } = await setup();
		a.deps.engine.deleteGuardThreshold = 0;
		let called = 0;
		a.deps.confirmLocalDeletes = async () => {
			called++;
			return "cancel";
		};
		const r = await a.sync(true);
		expect(called).toBe(0);
		expect(fileExists(a, "F/n1.md")).toBe(false);
		void r;
	});
});

