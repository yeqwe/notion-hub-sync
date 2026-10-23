// What the sync log is allowed to say.
//
// The log exists to be read. A vault with a few thousand notes produces one
// line per file per round if the detail goes to the user-facing channel, and
// a log nobody can read is the same as no log — so these tests pin the two
// halves of the contract:
//
//   • milestones land in `log` (a round can be reconstructed from them),
//   • per-file detail lands in `debug` only (and an idle round stays quiet).

import { describe, expect, it } from "vitest";
import { makeDevice } from "../../test-support/device";
import { FakeNotion } from "../../test-support/fake-notion";

function recorder() {
	const log: string[] = [];
	const debug: string[] = [];
	return {
		log,
		debug,
		wire(device: ReturnType<typeof makeDevice>) {
			device.deps.log = (m) => log.push(m);
			device.deps.debug = (m) => debug.push(m);
			return device;
		},
	};
}

async function setup() {
	const fake = new FakeNotion();
	const root = fake.humanCreatePage("", "root");
	const rec = recorder();
	const a = rec.wire(makeDevice(fake, root, "a"));
	return { fake, root, rec, a };
}

describe("sync log signal", () => {
	it("a round with real work reports milestones, not one line per file", async () => {
		const { a, rec } = await setup();
		for (let i = 0; i < 12; i++) a.write(`n${i}.md`, `# note ${i}\n`);

		await a.sync();

		// Milestones present: the round can be followed from start to end.
		expect(rec.log.some((m) => m.includes("round start"))).toBe(true);
		expect(rec.log.some((m) => m.includes("round done"))).toBe(true);
		expect(rec.log.some((m) => m.includes("phase scanLocal"))).toBe(true);
		expect(rec.log.some((m) => m.includes("phase apply"))).toBe(true);

		// 12 new notes must not produce 12 user-facing lines.
		const perFile = rec.log.filter((m) => /n\d+\.md/.test(m));
		expect(perFile.length).toBeLessThan(12);
	});

	it("per-file detail goes to the debug channel", async () => {
		const { a, rec } = await setup();
		a.write("a.md", "# a\n");
		a.write("b.md", "# b\n");

		await a.sync();

		// every file is accounted for on the debug channel...
		expect(rec.debug.some((m) => m.includes("a.md"))).toBe(true);
		expect(rec.debug.some((m) => m.includes("b.md"))).toBe(true);
		// ...and the user-facing log stays small
		expect(rec.log.length).toBeLessThan(20);
	});

	it("an idle round is quiet: two lines, no phase noise", async () => {
		const { a, rec } = await setup();
		a.write("a.md", "# a\n");
		await a.sync();
		rec.log.length = 0;
		rec.debug.length = 0;

		await a.sync(); // nothing changed

		expect(rec.log.length).toBeLessThanOrEqual(3);
		expect(rec.log.some((m) => m.includes("round start"))).toBe(true);
		expect(rec.log.some((m) => m.includes("nothing to do"))).toBe(true);		// the machinery it skipped is still visible to a maintainer
		expect(rec.debug.length).toBeGreaterThan(0);
	});

	it("hashing is summarised, never enumerated, in the user-facing log", async () => {
		const { a, rec } = await setup();
		for (let i = 0; i < 8; i++) a.write(`f${i}.md`, `# f${i}\n`);
		await a.sync();
		rec.log.length = 0;
		rec.debug.length = 0;

		// change every file → every one gets re-hashed next round
		for (let i = 0; i < 8; i++) a.write(`f${i}.md`, `# f${i} changed\n`);
		await a.sync();

		const hashLines = rec.log.filter((m) => /hash /i.test(m));
		expect(hashLines).toEqual([]);
		const debugHashLines = rec.debug.filter((m) => /hash /i.test(m));
		expect(debugHashLines.length).toBeGreaterThan(0);
	});

	it("a failure is a milestone: it reaches the user-facing log", async () => {
		const { a, rec, fake } = await setup();
		a.write("a.md", "# a\n");
		await a.sync();
		rec.log.length = 0;

		// break the remote side for the next push
		fake.failOnce(/\/pages\/.*\/markdown/, "PATCH");
		a.write("a.md", "# a changed\n");
		const report = await a.sync();

		expect(report.failed).toBeGreaterThan(0);
		expect(rec.log.some((m) => /fail/i.test(m))).toBe(true);
	});
});
