// Structured sync events (deps.event): phases + per-action progress +
// upload parts, emitted over the two-device harness.

import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice } from "../../test-support/device";
import type { SyncEvent } from "../sync/deps";

function setup() {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a");
	const events: SyncEvent[] = [];
	a.deps.event = (ev) => events.push(ev);
	return { fake, rootId, a, events };
}

describe("sync events", () => {
	it("first sync emits phases in order, counted actions, and an upload", async () => {
		const { a, events } = setup();
		a.write("Dir/note.md", "hello\n");
		writeFileSync(join(a.dir, "Dir", "img.png"), new Uint8Array([1, 2, 3]));

		const report = await a.sync();
		expect(report.failed).toBe(0);

		// phases in order
		const phases = events
			.filter((e) => e.t === "phase")
			.map((e) => (e.t === "phase" ? e.phase : ""));
		expect(phases.slice(0, 3)).toEqual([
			"scanLocal",
			"scanRemote",
			"plan",
		]);

		// scan events: local hashing + tree walk appear before plan
		const planIdx = events.findIndex(
			(e) => e.t === "phase" && e.phase === "plan",
		);
		const scans = events.filter((e) => e.t === "scan");
		const stages = scans.map((e) => (e.t === "scan" ? e.stage : ""));
		expect(stages).toContain("local");
		expect(stages).toContain("walk");
		const firstScan = events.indexOf(scans[0]!);
		expect(firstScan).toBeLessThan(planIdx);

		const planEv = events.find(
			(e) => e.t === "phase" && e.phase === "plan",
		);
		const planned = planEv?.t === "phase" ? (planEv.count ?? 0) : -1;
		expect(planned).toBeGreaterThan(0);

		// action events: done runs 1..total, total == plan count
		const acts = events.filter((e) => e.t === "action");
		expect(acts.length).toBe(planned);
		expect(acts.map((e) => (e.t === "action" ? e.done : 0))).toEqual(
			acts.map((_, i) => i + 1),
		);
		for (const e of acts) {
			expect(e.t === "action" ? e.total : 0).toBe(planned);
		}

		// folder + note + file pushes present with paths
		expect(
			acts.some(
				(e) =>
					e.t === "action" &&
					e.action === "createRemoteFolder" &&
					e.path === "Dir",
			),
		).toBe(true);
		expect(
			acts.some(
				(e) =>
					e.t === "action" &&
					e.action === "pushNew" &&
					e.path === "Dir/note.md",
			),
		).toBe(true);

		const uploads = events.filter((e) => e.t === "upload");
		expect(
			uploads.some(
				(e) =>
					e.t === "upload" &&
					e.path === "Dir/img.png" &&
					e.part === 1 &&
					e.parts === 1 &&
					e.bytes === 3,
			),
		).toBe(true);

		// journal phase emitted (new entries → journal ops)
		expect(phases).toContain("journal");
	});

	it("skips incremental search on first sync, searches on the second", async () => {
		const { fake, a } = setup();
		a.write("n.md", "x\n");
		await a.sync();
		// no cursor + audit due → the incremental search is skipped; the
		// only /search call is the audit's own paginated scan.
		expect(
			fake.reqLog.filter(
				(r) => r.method === "POST" && r.path === "/search",
			).length,
		).toBe(1);
		expect(a.state.searchCursor).toBeTruthy();
		fake.reqLog.length = 0;
		await a.sync();
		expect(
			fake.reqLog.some(
				(r) => r.method === "POST" && r.path === "/search",
			),
		).toBe(true);
	});

	it("actionFailed carries the action path", async () => {
		const { fake, a, events } = setup();
		void fake;
		a.write("n.md", "x\n");
		// fail every mutating request → apply fails, snapshots still work
		const orig = a.deps.client.request.bind(a.deps.client);
		a.deps.client.request = (async (
			method: "GET" | "POST" | "PATCH" | "DELETE",
			path: string,
			body?: unknown,
		) => {
			if (method !== "GET" && !path.startsWith("/search"))
				throw new Error("injected");
			return orig(method, path, body);
		}) as typeof a.deps.client.request;
		const report = await a.sync();
		expect(report.failed).toBeGreaterThan(0);
		const failed = events.filter((e) => e.t === "actionFailed");
		expect(failed.length).toBeGreaterThan(0);
		expect(
			failed.some((e) => e.t === "actionFailed" && e.path === "n.md"),
		).toBe(true);
	});
});
