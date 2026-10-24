// The content spot-check has a fixed budget (roundRobinPerRound downloads per
// round), and it is the ONLY thing that can catch an edit whose
// `last_edited_time` did not move (API writes, same-minute human edits).
//
// The guarantee that matters is therefore coverage: every file must be
// content-compared within a bounded number of rounds. These tests pin that down
// so a future "smarter" ordering cannot quietly starve the quiet majority.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, type Device } from "../../test-support/device";
import { defaultConfigSync } from "../config/filter";
import { snapshotRemote } from "./remote";
import { makeLinks } from "../sync/push";
import { ROUND_ROBIN_PER_ROUND } from "../settings";

function setup(pages: number, rr = ROUND_ROBIN_PER_ROUND) {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a", {
		roundRobinPerRound: rr,
		fullAuditHours: 10_000,
		configSync: { ...defaultConfigSync(), enabled: false },
	});
	for (let i = 0; i < pages; i++) a.write(`n${i}.md`, `# ${i}\n`);
	return { fake, a };
}

/** Which ids the round actually downloaded content for.
 *
 * Read from the request log, not from `fetchedBytes`: `evalNote` returns early
 * without caching when the content turns out unchanged, so the cache is empty
 * for exactly the pages the sample verified as "no change".
 */
async function checkedIds(d: Device, fake: FakeNotion): Promise<Set<string>> {
	fake.reqLog.length = 0;
	await snapshotRemote(d.deps, {
		full: false,
		roundRobinPerRound: d.deps.engine.roundRobinPerRound,
		fullAuditHours: 10_000,
		links: makeLinks(d.deps),
		now: fake.now,
	});
	const out = new Set<string>();
	for (const r of fake.reqLog) {
		const m = r.path.match(/^\/pages\/([0-9a-f]{32})\/markdown$/);
		if (m) out.add(m[1]!);
	}
	return out;
}

describe("内容抽查的覆盖率", () => {
	it("每个文件都会在有限的轮数内被内容比对（不会被冷落）", async () => {
		const files = 40;
		const { fake, a } = setup(files);
		await a.sync();
		await a.sync();

		const ids = Object.keys(a.state.entries).filter(
			(id) => a.state.entries[id]!.kind !== "folder",
		);
		const seen = new Set<string>();
		const maxRounds = Math.ceil(files / ROUND_ROBIN_PER_ROUND) + 2;
		for (let round = 0; round < maxRounds; round++) {
			for (const id of await checkedIds(a, fake)) seen.add(id);
			// advance the clock the way a real round would
			for (const id of seen) {
				const e = a.state.entries[id];
				if (e) e.checkedAt = fake.now;
			}
			fake.now += 60_000;
		}
		expect(seen.size).toBe(ids.length);
	});

	it("从没验证过内容的条目优先", async () => {
		const { fake, a } = setup(60);
		await a.sync();
		await a.sync();

		const ids = Object.keys(a.state.entries).filter(
			(id) => a.state.entries[id]!.kind !== "folder",
		);
		const target = ids[0]!;
		// Simulate "never verified": no base sha at all.
		const e = a.state.entries[target]!;
		e.srcSha = undefined;
		e.localHash = undefined;
		e.fileSha = undefined;
		// Recently checked, so plain FIFO would skip it for a full cycle.
		for (const id of ids) a.state.entries[id]!.checkedAt = fake.now;

		const checked = await checkedIds(a, fake);
		expect(checked.has(target)).toBe(true);
	});

	it("抽查预算不被超出（请求数有界）", async () => {
		const { fake, a } = setup(200);
		await a.sync();
		await a.sync();
		const checked = await checkedIds(a, fake);
		expect(checked.size).toBeLessThanOrEqual(ROUND_ROBIN_PER_ROUND);
	});
});
