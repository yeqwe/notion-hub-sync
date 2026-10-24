// Request-budget regression tests: idle rounds must be O(1) in vault size
// (journal read + search + ≤ ROUND_ROBIN_PER_ROUND evals + config check).
// Run with FakeNotion.reqLog so counts are endpoint-accurate.

import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, type Device } from "../../test-support/device";
import { defaultConfigSync } from "../config/filter";
import { ROUND_ROBIN_PER_ROUND } from "../settings";
import type { RequestFn } from "../notion/client";

function setup(fileCount: number, rr = ROUND_ROBIN_PER_ROUND) {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a", {
		roundRobinPerRound: rr,
		configSync: defaultConfigSync(),
	});
	// notes across two folders + 2 small images
	const perFolder = Math.floor(fileCount / 2) - 1;
	for (let i = 0; i < perFolder; i++) {
		a.write(`f1/n${i}.md`, `# n${i}\nbody\n`);
		a.write(`f2/n${i}.md`, `# m${i}\nbody\n`);
	}
	writeFileSync(join(a.dir, "f1", "a.png"), Buffer.alloc(1024, 1));
	writeFileSync(join(a.dir, "f2", "b.png"), Buffer.alloc(2048, 2));
	return { fake, rootId, a };
}

async function counted(d: Device, fake: FakeNotion, full = false) {
	fake.reqLog.length = 0;
	await d.sync(full);
	return fake.reqLog.length;
}

function byOp(fake: FakeNotion): Record<string, number> {
	const out: Record<string, number> = {};
	for (const r of fake.reqLog) {
		const p = r.path.replace(/[0-9a-f]{32}/g, "{id}").replace(/\?.*$/, "");
		const k = `${r.method} ${p}`;
		out[k] = (out[k] ?? 0) + 1;
	}
	return out;
}

describe("request budgets", () => {
	it("bootstrap creates zero history pages/versions", async () => {
		const { fake, a } = setup(22);
		await a.sync();
		const titles = [...fake.pages.values()].map((p) => p.title);
		expect(
			titles.some((t) => t.includes("同步历史") || t.includes("🗄️")),
		).toBe(false);
	});

	// 2 fixed requests (journal + /search) + 2 per spot-checked file
	// (GET /pages + GET markdown). Independent of vault size.
	const IDLE_BUDGET = 2 + 2 * ROUND_ROBIN_PER_ROUND;

	it("idle round stays within the spot-check budget (22-file vault)", async () => {
		const { fake, a } = setup(22);
		await a.sync(); // bootstrap
		await a.sync(); // warm: stamps remoteEdited on every entry
		const n = await counted(a, fake);
		console.log("idle 22-file:", JSON.stringify(byOp(fake)));
		expect(n).toBeLessThanOrEqual(IDLE_BUDGET);
	});

	it("idle round budget is vault-size independent (60-file vault)", async () => {
		const { fake, a } = setup(60);
		await a.sync();
		await a.sync();
		const n = await counted(a, fake);
		console.log("idle 60-file:", JSON.stringify(byOp(fake)));
		expect(n).toBeLessThanOrEqual(IDLE_BUDGET);
	});

	it("one-note-edit round ≤ idle + 6", async () => {
		const { fake, a } = setup(22);
		await a.sync();
		// warm history infra once: first-ever version lazily creates the
		// 🗄️ container + per-file history page (2 one-time POST /pages)
		a.write("f1/n0.md", "# n0\nwarm\n");
		await a.sync();
		await a.sync();
		const idle = await counted(a, fake);
		a.write("f1/n0.md", "# n0\nedited\n");
		const edit = await counted(a, fake);
		console.log(
			`idle=${idle} edit=${edit}`,
			JSON.stringify(byOp(fake)),
		);
		// +1 vs the pre-existing budget: a push re-reads the page's
		// last_edited_time before overwriting, so a remote edit made after
		// this round's snapshot is not silently replaced.
		expect(edit).toBeLessThanOrEqual(idle + 7);
	});

	it("pushNew stamps fileSha/mediaBlockId even with dashed page ids", async () => {
		// Regression: pushNew passed the dashed rawId to pushFileContent,
		// which looked up state.entries[rawId] and silently failed to
		// stamp fileSha → base sha stayed null → the file was re-pushed
		// on every later round where the remote side wasn't evaluated.
		const fake = new FakeNotion({ dashIds: true });
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", {
			configSync: defaultConfigSync(),
		});
		writeFileSync(join(a.dir, "a.png"), Buffer.alloc(1024, 1));
		const r0 = await a.sync();
		expect(r0.failed).toBe(0);
		const e = Object.values(a.state.entries).find(
			(x) => x.path === "a.png",
		);
		expect(e?.fileSha).toBeTruthy();
		expect(e?.mediaBlockId).toBeTruthy();
		// several later rounds: never re-uploaded
		for (let i = 0; i < 3; i++) {
			fake.reqLog.length = 0;
			const r = await a.sync();
			expect(r.updated).toBe(0);
			expect(
				fake.reqLog.filter((x) =>
					x.path.includes("file_uploads"),
				),
			).toHaveLength(0);
		}
	});

	it("report counts one update per pushContent action", async () => {
		const { a } = setup(22);
		await a.sync();
		a.write("f1/n0.md", "# n0\nedited\n");
		const r = await a.sync();
		expect(r.updated).toBe(1);
	});

	it("10 note edits apply in parallel (max in-flight > 1)", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		let inFlight = 0;
		let maxInFlight = 0;
		const instrumented: RequestFn = async (r) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			try {
				await new Promise((res) => setTimeout(res, 1));
				return await fake.request(r);
			} finally {
				inFlight--;
			}
		};
		const a = makeDevice(fake, rootId, "a", { request: instrumented });
		for (let i = 0; i < 10; i++) a.write(`n${i}.md`, `v1-${i}\n`);
		await a.sync();
		for (let i = 0; i < 10; i++) a.write(`n${i}.md`, `v2-${i}\n`);
		const r = await a.sync();
		expect(r.failed).toBe(0);
		expect(maxInFlight).toBeGreaterThan(1);
		for (let i = 0; i < 10; i++) {
			const pg = [...fake.pages.values()].find((p) =>
				p.title === `n${i}`,
			);
			expect(pg?.markdown).toContain(`v2-${i}`);
		}
	});
});
