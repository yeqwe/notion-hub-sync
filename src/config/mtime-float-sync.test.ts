// 端到端：base 里存的是「整数 mtime + 浮点磁盘值」时，不能每轮重读重传。
//
// 这条路径在真实 vault 上踩过：Windows 的 adapter.stat() 返回
// `1792825000985.459`，base 存成 `1792825000985`，`===` 永远不成立。
// 后果不是"慢一点"——本地 sha 每轮重算，而远端未评估时 planner 会把它
// 判成 pushContent，于是同一个文件被反复上传。

import { describe, expect, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, type Device } from "../../test-support/device";
import { defaultConfigSync } from "../config/filter";

/** A ConfigIO whose stat() reports fractional mtimes, like Obsidian on Windows. */
function floatyConfigIO(d: Device) {
	const io = d.deps.configIO!;
	const orig = io.stat.bind(io);
	(io as { stat: typeof orig }).stat = async (p: string) => {
		const st = await orig(p);
		return st ? { size: st.size, mtime: st.mtime + 0.459 } : null;
	};
}

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

		// 第一轮：写入 base（此时 IO 还是正常的整数）
		await a.sync();
		const rel = "plugins/p0/main.js";
		expect(a.state.config?.[rel]).toBeDefined();
		// 模拟旧版本写下的记录：磁盘是浮点，base 是整数
		floatyConfigIO(a);

		// 后续几轮：不得重读、不得重传
		for (let i = 0; i < 3; i++) {
			const reads: string[] = [];
			const io = a.deps.configIO!;
			const orig = io.readBinary.bind(io);
			(io as { readBinary: typeof orig }).readBinary = async (p: string) => {
				reads.push(p);
				return orig(p);
			};
			fake.reqLog.length = 0;
			const r = await a.sync();
			(io as { readBinary: typeof orig }).readBinary = orig;
			console.log(
				`round ${i}: reads=${JSON.stringify(reads)} updated=${r.updated} ` +
					`baseMtime=${a.state.config?.[rel]?.localMtime}`,
			);
			expect(reads).not.toContain(rel);
			expect(r.updated).toBe(0);
			expect(
				fake.reqLog.filter((q) => q.path.includes("file_uploads")),
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
		floatyConfigIO(a);

		writeFileSync(join(dir, "main.js"), "y".repeat(2000));
		const r = await a.sync();
		expect(r.failed).toBe(0);
		await b.sync();
		expect(
			b.read(".obsidian/plugins/p0/main.js").length,
		).toBe(2000);
	});

	it("笔记同步：本地未改动的文件不会被当成 changed", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		const p = join(a.dir, "N.md");
		writeFileSync(p, "hello\n");
		await a.sync();
		await a.sync();

		// 账本里的 mtime 现在与磁盘一致；把它改成"旧版本写下的整数"
		const id = Object.keys(a.state.entries)[0]!;
		const e = a.state.entries[id]!;
		e.localMtime = Math.round(e.localMtime ?? 0) + 0.459;

		fake.reqLog.length = 0;
		const r = await a.sync();
		expect(r.updated).toBe(0);
		expect(
			fake.reqLog.filter((q) => q.method === "PATCH" && q.path.includes("markdown")),
		).toHaveLength(0);
		void dirname;
	});
});
