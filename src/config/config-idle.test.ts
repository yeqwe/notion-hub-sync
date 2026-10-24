// "开了插件同步，但不要每轮都反复折腾插件" — an idle round must spend ZERO
// requests and ZERO local reads on `.obsidian`, whatever is switched on.
//
// Measured before this regression test existed (5 installed plugins,
// communityPlugin on, communityPluginData off):
//   idle round → 33 Notion requests + 15 file reads (~1.5 MB)
// Two causes, both fixed:
//   • `runSync` passed `opts.full || remoteSnap.auditDue` to the config
//     pass, and `auditDue` is true on EVERY round while
//     `scanStructureEveryRound` is on (the default) — that value belongs to
//     the NOTE tree, and it re-enumerated the whole ⚙️ tree every round.
//   • the local walk re-hashed every config file although `localMtime` /
//     `localSize` were already recorded in the base.

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, type Device } from "../../test-support/device";
import { defaultConfigSync, type ConfigSyncSettings } from "./filter";

const PLUGINS = 5;

/** A vault with N installed community plugins (code only, no data.json). */
function setup(opts?: {
	configSync?: ConfigSyncSettings;
	plugins?: number;
	rootId?: string;
	fake?: FakeNotion;
	label?: string;
}) {
	const n = opts?.plugins ?? PLUGINS;
	const fake = opts?.fake ?? new FakeNotion();
	const rootId = opts?.rootId ?? fake.humanCreatePage("", "root");
	const cfg: ConfigSyncSettings = opts?.configSync ?? {
		...defaultConfigSync(),
		communityPlugin: true,
	};
	const a = makeDevice(fake, rootId, opts?.label ?? "a", {
		configSync: cfg,
		// `fullAuditHours` keeps the slower note-tree WALK out of the
		// measurements; `scanStructureEveryRound` (on by default) is what
		// `runSync` turns into `auditDue: true` on every round.
		fullAuditHours: 10_000,
	});
	for (let i = 0; i < n; i++) {
		const dir = join(a.dir, ".obsidian", "plugins", `p${i}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "manifest.json"), `{"id":"p${i}"}`);
		writeFileSync(join(dir, "main.js"), "x".repeat(200_000));
		writeFileSync(join(dir, "styles.css"), ".a{}");
	}
	return { fake, a, rootId };
}

/** Count ConfigIO byte reads while `fn` runs, split by file kind. */
async function countReads(
	d: Device,
	fn: () => Promise<unknown>,
): Promise<{ reads: number; bytes: number; big: number; bigBytes: number }> {
	const io = d.deps.configIO!;
	const orig = io.readBinary.bind(io);
	let reads = 0;
	let bytes = 0;
	let big = 0;
	let bigBytes = 0;
	(io as { readBinary: typeof orig }).readBinary = async (p: string) => {
		reads++;
		const b = await orig(p);
		bytes += b.byteLength;
		if (!p.toLowerCase().endsWith(".json")) {
			big++;
			bigBytes += b.byteLength;
		}
		return b;
	};
	try {
		await fn();
	} finally {
		(io as { readBinary: typeof orig }).readBinary = orig;
	}
	return { reads, bytes, big, bigBytes };
}

/** Requests one idle round makes, for a device in the given shape. */
async function idleRequests(cfg: ConfigSyncSettings, plugins: number) {
	const { fake, a } = setup({ configSync: cfg, plugins });
	await a.sync(); // bootstrap
	await a.sync(); // warm
	fake.reqLog.length = 0;
	await a.sync();
	return { reqs: fake.reqLog.length, fake, a };
}

describe("插件同步不再每轮空转", () => {
	it("idle 轮：大文件 0 次读盘，且请求数与「插件同步全关」完全相同", async () => {
		const off = await idleRequests(
			{ ...defaultConfigSync(), communityPlugin: false },
			0,
		);
		const on = await idleRequests(
			{ ...defaultConfigSync(), communityPlugin: true },
			PLUGINS,
		);
		// 5 plugins × 3 files on disk, and NOT ONE byte of code read back
		expect(on.a.state.config && Object.keys(on.a.state.config).length).toBe(
			PLUGINS * 3,
		);
		const r = await countReads(on.a, () => on.a.sync());
		// main.js / styles.css take the mtime+size path: zero reads, zero bytes
		expect(r.big).toBe(0);
		expect(r.bigBytes).toBe(0);
		// only the tiny manifest.json files are re-read (see statIsEnough)
		expect(r.reads).toBe(PLUGINS);
		expect(r.bytes).toBeLessThan(4096);
		// the whole point: installed plugins cost not a single extra request
		console.log(
			`idle reqs: plugins-off=${off.reqs} plugins-on=${on.reqs} ` +
				`reads=${r.reads} bytes=${r.bytes}`,
		);
		expect(on.reqs).toBe(off.reqs);
	});

	it("插件更新（mtime/size 变了）→ 下一轮照常推送到另一台设备", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const cfg = { ...defaultConfigSync(), communityPlugin: true };
		const { a } = setup({ configSync: cfg, fake, rootId, label: "a" });
		const b = setup({
			configSync: cfg,
			plugins: 0,
			fake,
			rootId,
			label: "b",
		}).a;
		await a.sync();
		await b.sync();
		expect(b.read(".obsidian/plugins/p0/main.js").length).toBe(200_000);

		// a plugin update rewrites main.js: different size
		writeFileSync(
			join(a.dir, ".obsidian", "plugins", "p0", "main.js"),
			"y".repeat(250_000),
		);
		const r = await a.sync();
		expect(r.failed).toBe(0);
		await b.sync();
		expect(b.read(".obsidian/plugins/p0/main.js").length).toBe(250_000);
	});

	it("只 touch（mtime 变、内容没变）→ 大文件读一次就认账，之后恢复 0 读盘", async () => {
		const { a } = setup({ plugins: 1 });
		await a.sync();
		// rewrite identical bytes: mtime moves, sha does not
		writeFileSync(
			join(a.dir, ".obsidian", "plugins", "p0", "main.js"),
			"x".repeat(200_000),
		);
		const touched = await countReads(a, () => a.sync());
		// read once to prove the content is unchanged …
		expect(touched.big).toBe(1);
		// … and the new stat is adopted, so it never happens again
		const after = await countReads(a, () => a.sync());
		expect(after.big).toBe(0);
	});

	it("另一台设备经 journal 修改配置 → 本机立刻收到，不等全量审计", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const cfg = { ...defaultConfigSync() };
		const a = makeDevice(fake, rootId, "a", { configSync: cfg });
		const b = makeDevice(fake, rootId, "b", { configSync: cfg });
		mkdirSync(join(a.dir, ".obsidian"), { recursive: true });
		writeFileSync(
			join(a.dir, ".obsidian", "appearance.json"),
			'{"theme":"dark"}',
		);
		await a.sync();
		await b.sync();
		writeFileSync(
			join(a.dir, ".obsidian", "appearance.json"),
			'{"theme":"light"}',
		);
		await a.sync();

		// B's own audit timer has not expired (2h default); the journal is
		// what carries the change, and it must still be applied this round.
		const rb = await b.sync();
		expect(rb.failed).toBe(0);
		expect(b.read(".obsidian/appearance.json")).toBe('{"theme":"light"}');
	});

	it("配置页被人在 Notion 里删掉 → 全量审计窗口打开时发现", async () => {
		const { fake, a } = setup({ plugins: 1 });
		await a.sync();
		const rel = "plugins/p0/main.js";
		expect(a.state.config?.[rel]).toBeDefined();
		fake.humanTrash(a.state.config![rel]!.pageId);
		// the audit window has to open for a hand-made remote deletion to be
		// noticed at all — the base is trusted in between
		a.state.lastConfigAudit = 0;
		await a.sync();
		// remote gone + local unchanged → the local copy is trashed
		expect(a.state.config?.[rel]).toBeUndefined();
	});

	it("全量审计窗口内：不重新枚举，也就不会白花每页 2 个请求", async () => {
		const { fake, a } = setup();
		await a.sync();
		await a.sync();
		const audited = a.state.lastConfigAudit;
		expect(audited).toBeDefined();
		fake.reqLog.length = 0;
		await a.sync();
		// window is 2h wide; the fake clock stands still, so no re-audit
		expect(a.state.lastConfigAudit).toBe(audited);
		expect(
			fake.reqLog.filter((q) => q.path.startsWith("/blocks/")).length,
		).toBeLessThanOrEqual(2); // note-tree system pages only
	});
});
