// Regression: "the remote page is gone" must be OBSERVED every round, not
// inferred from the absence of a journal entry.
//
// The incremental round only evaluates journal candidates, search hits and
// the round-robin sample. Every other entry reads as "unchanged" — a guess.
// A page deleted in Notion (by a human, or by another device whose journal
// block was pruned) then stays invisible until the 6-hour audit, and the
// local file keeps looking fine while the remote copy is gone.
//
// The structural scan costs ~1 request per 100 pages (`/search`), which the
// measurements showed is CHEAPER than the round-robin GETs it replaces.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, fileExists, type Device } from "../../test-support/device";
import { defaultConfigSync } from "../config/filter";

function setup(rr = 0) {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a", {
		roundRobinPerRound: rr,
		fullAuditHours: 10_000, // 平时的定时审计关掉，只靠每轮结构扫描
		configSync: { ...defaultConfigSync(), enabled: false },
	});
	const b = makeDevice(fake, rootId, "b", {
		roundRobinPerRound: rr,
		fullAuditHours: 10_000,
		configSync: { ...defaultConfigSync(), enabled: false },
	});
	return { fake, rootId, a, b };
}

function byPath(d: Device, path: string): string | undefined {
	return Object.entries(d.state.entries).find(([, e]) => e.path === path)?.[0];
}

describe("每轮结构扫描", () => {
	it("远端页面被人工删除 → 下一轮立刻发现，不用等 6 小时", async () => {
		const { fake, a, b } = setup();
		a.write("keep.md", "keep\n");
		a.write("gone.md", "gone\n");
		await a.sync();
		await b.sync();
		const id = byPath(b, "gone.md")!;
		expect(id).toBeDefined();

		// 有人直接在 Notion 里删掉了那一页（没有 journal 记录）
		fake.humanTrash(id);

		// 一个增量轮就该发现
		const r = await b.sync();
		expect(fileExists(b, "gone.md")).toBe(false);
		expect(fileExists(b, "keep.md")).toBe(true);
		expect(r.failed).toBe(0);
	});

	it("远端页面被移动到树外 → 下一轮发现", async () => {
		const { fake, a, b } = setup();
		a.write("moved.md", "x\n");
		await a.sync();
		await b.sync();
		const id = byPath(b, "moved.md")!;

		const outside = fake.humanCreatePage("", "outside");
		fake.humanMove(id, outside);

		await b.sync();
		expect(fileExists(b, "moved.md")).toBe(false);
	});

	it("远端页面被改名 → 下一轮本地跟着改名", async () => {
		const { fake, a, b } = setup();
		a.write("old.md", "x\n");
		await a.sync();
		await b.sync();
		const id = byPath(b, "old.md")!;

		fake.humanRename(id, "new");

		await b.sync();
		expect(fileExists(b, "new.md")).toBe(true);
		expect(fileExists(b, "old.md")).toBe(false);
	});

	it("结构扫描的请求数随页数线性增长（100 页/请求）", async () => {
		const { fake, a } = setup();
		for (let i = 0; i < 250; i++) a.write(`n${i}.md`, `# ${i}\n`);
		await a.sync();
		await a.sync();
		fake.reqLog.length = 0;
		await a.sync();
		const searches = fake.reqLog.filter((r) =>
			r.path.startsWith("/search"),
		).length;
		// 250 页 ≈ 3 页 /search（100/页），加上本轮可能的补扫。
		// 重点不是精确值，而是「不随页数爆炸」：请求数 ≈ ceil(页数/100) + 常数。
		expect(searches).toBeGreaterThanOrEqual(1);
		expect(searches).toBeLessThanOrEqual(8);
	});
});
