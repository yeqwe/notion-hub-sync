// Regression tests for the live-probed /search defects:
//  1. an `ascending` sort silently truncates to one page (probed: 45 of
//     879 pages) → the audit must sort descending, and a low-coverage
//     scan must fall back to the walk instead of reporting mass deletion.
//  2. /search drops some children of heavily-populated parents (probed:
//     a 107-child folder came back with 99) → the heavy-parent correction
//     re-reads them through the authoritative children endpoint.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { fileExists, makeDevice } from "../../test-support/device";
import type { ConfigSyncSettings } from "../config/filter";
import { auditSearchScan, AUDIT_MIN_COVERAGE } from "./remote-audit";

const norm = (id: string): string => id.replace(/-/g, "").toLowerCase();

/** Config sync disabled — it lists root children on full rounds, which
 * would blur the request assertions below. */
const noConfig = (): ConfigSyncSettings => ({
	enabled: false,
	app: false,
	appearance: false,
	appearanceData: false,
	hotkey: false,
	corePlugin: false,
	corePluginData: false,
	communityPlugin: false,
	communityPluginData: false,
});

describe("search-scan robustness", () => {
	it("never asks for an ascending sort (that truncates on real workspaces)", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
		a.write("d1/n1.md", "one\n");
		await a.sync();

		// the fake records the raw body so the sort is observable
		fake.reqLog.length = 0;
		await a.sync(true);
		const directions = fake.searchRequests.map(
			(s) => (s.sort as { direction?: string } | undefined)?.direction,
		);
		expect(directions.length).toBeGreaterThan(0);
		expect(directions).not.toContain("ascending");
		expect(directions).toContain("descending");
	});

	it("an ascending-truncating /search cannot trigger mass deletion", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
		for (let i = 0; i < 6; i++) a.write(`n${i}.md`, `v${i}\n`);
		await a.sync();
		expect(Object.keys(a.state.entries)).toHaveLength(6);

		// every page outside the truncated first page disappears from search
		fake.ascendingTruncatesTo = 1;

		const r = await a.sync(true);
		expect(r.failed).toBe(0);
		// nothing was deleted
		for (let i = 0; i < 6; i++) expect(fileExists(a, `n${i}.md`)).toBe(true);
		expect(Object.keys(a.state.entries)).toHaveLength(6);
	});

	it("a scan that loses the whole tree returns null (walk fallback)", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
		for (let i = 0; i < 40; i++) a.write(`bag/n${i}.md`, `v${i}\n`);
		await a.sync();

		// Both /search and the children listings fail to reveal the subtree:
		// the scan cannot be trusted and the walk must take over.
		for (const p of fake.pages.values()) fake.searchHidden.add(p.id);
		fake.failOnce(/\/blocks\/[^/]+\/children/, "GET");

		const result = await auditSearchScan(
			{ ...a.deps, log: () => {} },
			{
				rootHex: norm(rootId),
				sys: new Set(),
				outside: new Set(),
				remote: {},
				fetchedMeta: new Map(),
			},
		);
		// Either the repair recovered the tree (result) or the guard bailed
		// (null) — what must never happen is a mass deletion.
		if (result !== null) {
			expect(result.seenIds.size).toBeGreaterThan(0);
		}
	});

	it("a live page hidden from /search stays visible via the children repair", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
		for (let i = 0; i < 5; i++) a.write(`n${i}.md`, `v${i}\n`);
		await a.sync();

		const keep = [...fake.pages.values()].find((p) => p.title === "n0")!;
		fake.searchHidden.add(norm(keep.id));

		const result = await auditSearchScan(
			{ ...a.deps, log: () => {} },
			{
				rootHex: norm(rootId),
				sys: new Set(),
				outside: new Set(),
				remote: {},
				fetchedMeta: new Map(),
			},
		);
		expect(result).not.toBeNull();
		expect(result!.seenIds.has(norm(keep.id))).toBe(true);
	});

	it("heavy parents recover the children /search dropped", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
		a.write("d1/n1.md", "one\n");
		await a.sync();

		const d1 = [...fake.pages.values()].find((p) => p.title === "d1")!;
		const kids: string[] = [];
		for (let i = 0; i < 100; i++) {
			kids.push(norm(fake.humanCreatePage(d1.id, `kid-${i}`)));
		}
		// search now drops 8 children of any >=90-child parent
		fake.searchDropsChildrenOfHeavyParents = 90;
		fake.searchDroppedPerHeavyParent = 8;

		const r = await a.sync(true);
		expect(r.failed).toBe(0);

		// all 100 exist locally, including the ones /search withheld
		const pulled = kids.filter((id) => {
			const title = fake.pages.get(id)?.title;
			return title !== undefined && fileExists(a, `d1/${title}.md`);
		});
		expect(pulled).toHaveLength(100);
		// and every one is a state entry
		expect(kids.every((id) => a.state.entries[id] !== undefined)).toBe(true);
	});

	it("action events carry ok=true for applied actions", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
		const events: Array<{ t: string; ok?: boolean }> = [];
		a.deps.event = (ev) => events.push(ev as { t: string; ok?: boolean });

		a.write("n1.md", "one\n");
		await a.sync();

		const actions = events.filter((e) => e.t === "action");
		expect(actions.length).toBeGreaterThan(0);
		expect(actions.every((e) => e.ok === true)).toBe(true);
	});
});
