// 浮点 mtime 回归测试。
//
// 现场症状（用户 vault，2965 条目）：
//   sync-state.json 里 app.json 的 localMtime = 1792825000985
//   磁盘上的实际值                  = 1792825000985.459
//   core-plugins.json: 491 vs 490.75
//
// Obsidian 的 `adapter.stat()` 在 Windows 上返回带小数的毫秒，而
// `TFile.stat.mtime`（vault 列表和笔记扫描器用的那个）是整数。用 `===`
// 比较两者永远不成立 → 每轮都把文件当"变了"重新读一遍。
//
// 大文件（remotely-save/main.js 4.2 MB）时间戳碰巧是整毫秒，所以没事；
// 但这条路径上任何一个非整毫秒的文件都会每轮重读、在远端未被评估时
// 重复上传。

import { describe, expect, it } from "vitest";
import { sameStat } from "./local";
import { normalizeStat } from "../config/config-io";

describe("mtime 比较不受浮点噪声影响", () => {
	it("整数 base 对浮点磁盘值仍然相等", () => {
		expect(sameStat(1792825000985, 1792825000985.459)).toBe(true);
		expect(sameStat(1792825000491, 1792825000490.75)).toBe(true);
		expect(sameStat(1792825001005, 1792825001005.007)).toBe(true);
	});

	it("真正的改动照样判为不同", () => {
		expect(sameStat(1792825000985, 1792825000986)).toBe(false);
		expect(sameStat(1792825000491, 1792825001491)).toBe(false);
	});

	it("缺失值不算相等（不能因为两边都 undefined 就复用 sha）", () => {
		expect(sameStat(undefined, 123)).toBe(false);
		expect(sameStat(123, undefined)).toBe(false);
		expect(sameStat(undefined, undefined)).toBe(false);
	});

	it("normalizeStat 在入口处取整，新写入的值是整数", () => {
		expect(normalizeStat({ size: 56, mtime: 1792825000985.459 })).toEqual({
			size: 56,
			mtime: 1792825000985,
		});
		expect(normalizeStat(null)).toBeNull();
	});
});
