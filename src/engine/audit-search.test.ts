// Search-scan audits: full audits paginate POST /search instead of the
// per-parent children walk (~1 request per 100 pages vs ~1 per parent).
// The walk remains as fallback for API failures / over-cap workspaces.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { fileExists, makeDevice } from "../../test-support/device";
import type { ConfigSyncSettings } from "../config/filter";

const norm = (id: string): string => id.replace(/-/g, "").toLowerCase();

function sysIdSet(state: {
	journalId?: string;
	configRootId?: string;
	historyRootId?: string;
}): Set<string> {
	return new Set(
		[state.journalId, state.configRootId, state.historyRootId]
			.filter((x): x is string => x !== undefined)
			.map(norm),
	);
}

/** Config sync disabled — it lists root children on full rounds, which
 * would look like a walk request to these assertions. */
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

/** GET /blocks/{id}/children targets, excluding system pages (journal
 * reads and history listings legitimately list children) and the root
 * itself — the audit always reads the root's direct children (one
 * request) to catch pages the search index has not caught up with yet.
 * The assertion here is that no *recursive* per-parent walk happens. */
function treeWalkCalls(
	fake: FakeNotion,
	sysIds: Set<string>,
	rootId?: string,
): string[] {
	return fake.reqLog
		.filter(
			(r) =>
				r.method === "GET" &&
				/^\/blocks\/[^/]+\/children/.test(r.path),
		)
		.map((r) => norm(r.path.split("/")[2]!))
		.filter(
			(id) =>
				!sysIds.has(id) &&
				(rootId === undefined || id !== norm(rootId)),
		);
}

describe("search-scan audits", () => {
	it("full audit via /search: remote add + delete, zero tree-walk requests", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
		a.write("d1/n1.md", "one\n");
		a.write("d2/n2.md", "two\n");
		await a.sync();

		const d1 = [...fake.pages.values()].find((p) => p.title === "d1")!;
		const n2 = [...fake.pages.values()].find((p) => p.title === "n2")!;
		fake.humanCreatePage(d1.id, "human-new");
		fake.humanTrash(n2.id);

		fake.reqLog.length = 0;
		const r = await a.sync(true);
		expect(r.failed).toBe(0);
		expect(r.failures).toEqual([]);

		// deletion detected and new page pulled — through /search alone
		expect(fileExists(a, "d2/n2.md")).toBe(false);
		expect(fileExists(a, "d1/human-new.md")).toBe(true);
		expect(fake.reqLog.some((x) => x.method === "POST" && x.path === "/search")).toBe(true);

		// the walk never listed a non-system page's children
		expect(treeWalkCalls(fake, sysIdSet(a.state), rootId)).toEqual([]);

		// the missing entry was confirmed by a direct GET before deletion
		expect(
			fake.reqLog.some(
				(x) => x.method === "GET" && x.path === `/pages/${n2.id}`,
			),
		).toBe(true);
	});

	it("search-index lag: hidden page survives the round, not deleted", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
		a.write("keep.md", "keep\n");
		a.write("other.md", "other\n");
		await a.sync();

		const keep = [...fake.pages.values()].find((p) => p.title === "keep")!;
		fake.searchHidden.add(norm(keep.id));

		const r = await a.sync(true);
		expect(r.failed).toBe(0);
		// A page missing from the index is either recovered from its parent's
		// children list or confirmed by a direct GET — either way it must not
		// be treated as deleted. The root-children correction normally settles
		// this without the GET, so only assert the outcome.
		expect(fileExists(a, "keep.md")).toBe(true);
		expect(a.read("keep.md")).toBe("keep\n");
		expect(a.state.entries[norm(keep.id)]).toBeDefined();
	});

	it("/search failure falls back to the tree walk", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
		a.write("d1/n1.md", "one\n");
		a.write("d2/n2.md", "two\n");
		await a.sync();

		const d1 = [...fake.pages.values()].find((p) => p.title === "d1")!;
		const n2 = [...fake.pages.values()].find((p) => p.title === "n2")!;
		fake.humanCreatePage(d1.id, "human-new");
		fake.humanTrash(n2.id);

		fake.failOnce(/^\/search$/, "POST");
		fake.reqLog.length = 0;
		const r = await a.sync(true);
		expect(r.failed).toBe(0);

		// the walk still found both changes — and really ran (non-system
		// children listings happened, unlike the /search path)
		expect(fileExists(a, "d2/n2.md")).toBe(false);
		expect(fileExists(a, "d1/human-new.md")).toBe(true);
		expect(
			treeWalkCalls(fake, sysIdSet(a.state), rootId).length,
		).toBeGreaterThan(0);
	});

	it("fresh device re-matches a populated vault with zero GET /pages calls", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
		a.write("f1/a.md", "a\n");
		a.write("f2/sub/b.md", "b\n");
		a.write("top.md", "top\n");
		await a.sync();

		const b = makeDevice(fake, rootId, "b", { configSync: noConfig() });
		fake.reqLog.length = 0;
		const r = await b.sync();
		expect(r.failed).toBe(0);
		expect(r.failures).toEqual([]);

		// all vault content pulled + linked (3 notes + 3 folders)
		for (const p of ["f1/a.md", "f2/sub/b.md", "top.md"]) {
			expect(fileExists(b, p)).toBe(true);
		}
		expect(Object.keys(b.state.entries)).toHaveLength(6);

		// kinds came from the /search icons — classifyPage never ran
		const pageGets = fake.reqLog.filter(
			(x) => x.method === "GET" && /^\/pages\/[^/]+$/.test(x.path),
		);
		expect(pageGets).toEqual([]);

		// the audit itself cost one /search page (<100 pages in the vault)
		expect(
			fake.reqLog.filter(
				(x) => x.method === "POST" && x.path === "/search",
			),
		).toHaveLength(1);
	});
});
