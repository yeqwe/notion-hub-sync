// 端到端：base 里存的是整数、磁盘 stat 返回浮点时，不能每轮重读重传。
//
// 现场症状（用户 vault，2965 条目）：
//   sync-state.json 里 app.json 的 localMtime = 1792825000985
//   磁盘上的实际值                  = 1792825000985.459
//
// Obsidian 的 `adapter.stat()` 在 Windows 上返回带小数的毫秒，而 base
// 用 `===` 比较 → 永远不成立 → 每轮重读重算 sha；远端本轮未评估时
// planner 还会判成 pushContent，于是反复上传。
//
// `NodeConfigIO` 直接返回 `mtimeMs`，本身就是浮点（实测
// `1792832994045.6074`），所以这个测试**不需要伪造**任何 stat：
// 第一轮 `statMtime()` 把整数写进 base，后续轮次比较的就是
// 「整数 base vs 浮点磁盘」，正是现场那个组合。

import { describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice } from "../../test-support/device";
import { defaultConfigSync } from "./filter";

describe("浮点 mtime 不制造重复同步", () => {
	it("配置同步：base 整数 / 磁盘浮点 → 不产生 action", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", {
			configSync: { ...defaultConfigSync(), communityPlugin: true },
		});
		const dir = join(a.dir, ".obsidian", "plugins", "p0");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "main.js"), "x".repeat(1000));

		// 第一轮：写入 base
		await a.sync();
		const rel = "plugins/p0/main.js";
		const base = a.state.config?.[rel];
		expect(base).toBeDefined();
		// base 必须是整数 —— 这就是 `statMtime()` 的职责
		expect(Number.isInteger(base!.localMtime)).toBe(true);
		// 而磁盘那边确实是浮点（Node 的 mtimeMs 精度远高于 1ms）
		const diskStat = await a.deps.configIO!.stat(rel);
		expect(diskStat).not.toBeNull();
		expect(Number.isInteger(diskStat!.mtime)).toBe(false);

		// 后续几轮：不得重读、不得重传
		const io = a.deps.configIO!;
		for (let i = 0; i < 3; i++) {
			const reads: string[] = [];
			const realRead = io.readBinary.bind(io);
			(io as { readBinary: typeof realRead }).readBinary = async (
				p: string,
			) => {
				reads.push(p);
				return realRead(p);
			};
			fake.reqLog.length = 0;
			const r = await a.sync();
			(io as { readBinary: typeof realRead }).readBinary = realRead;

			expect(reads, `round ${i}`).not.toContain(rel);
			expect(r.updated, `round ${i}`).toBe(0);
			expect(
				fake.reqLog.filter((q) => q.path.includes("file_uploads")),
				`round ${i}`,
			).toHaveLength(0);
		}
	});

	it("配置同步：内容真的变了照样推送（浮点比较不能把改动吞掉）", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const cfg = { ...defaultConfigSync(), communityPlugin: true };
		const a = makeDevice(fake, rootId, "a", { configSync: cfg });
		const b = makeDevice(fake, rootId, "b", { configSync: cfg });
		const dir = join(a.dir, ".obsidian", "plugins", "p0");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "main.js"), "x".repeat(1000));
		await a.sync();
		await b.sync();

		writeFileSync(join(dir, "main.js"), "y".repeat(2000));
		const r = await a.sync();
		expect(r.failed).toBe(0);
		await b.sync();
		expect(b.read(".obsidian/plugins/p0/main.js").length).toBe(2000);
	});

	it("笔记同步：base 存了浮点 mtime 时，本地未改动的文件不会被当成 changed", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		writeFileSync(join(a.dir, "N.md"), "hello\n");
		await a.sync();
		await a.sync();

		// 旧版本可能把 adapter 的浮点值写进了 base。模拟那份记录：
		// 磁盘/列表仍是整数，账本多一个小数（同一毫秒，取整后不变）。
		const id = Object.keys(a.state.entries)[0]!;
		const e = a.state.entries[id]!;
		expect(Number.isInteger(e.localMtime)).toBe(true);
		e.localMtime = e.localMtime! + 0.1;

		fake.reqLog.length = 0;
		const r = await a.sync();
		expect(r.updated).toBe(0);
		expect(
			fake.reqLog.filter(
				(q) => q.method === "PATCH" && q.path.includes("markdown"),
			),
		).toHaveLength(0);
		// 而且账本被顺手纠正成整数，下一轮开始就是干净比较
		expect(Number.isInteger(a.state.entries[id]!.localMtime)).toBe(true);
	});
});
