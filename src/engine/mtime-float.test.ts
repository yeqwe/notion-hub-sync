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
//
// 这里只测纯函数。端到端行为见 `mtime-float-sync.test.ts`。

import { describe, expect, it } from "vitest";
import { sameStat } from "./local";
import { normalizeStat } from "../config/config-io";

/** The exact values seen in the user's state file and on disk. */
const CASES: Array<[string, number, number]> = [
	["app.json", 1792825000985, 1792825000985.459],
	["core-plugins.json", 1792825000491, 1792825000490.75],
	["appearance.json", 1792825001005, 1792825001005.007],
	["workspaces.json", 1792736177890, 1792736177890.304],
];

describe("mtime 比较不受浮点噪声影响", () => {
	it("整数 base 对浮点磁盘值仍然相等（现场那四个文件）", () => {
		for (const [name, base, disk] of CASES) {
			expect(sameStat(base, disk), name).toBe(true);
		}
	});

	it("反方向也成立：浮点 base 对整数磁盘值", () => {
		for (const [name, base, disk] of CASES) {
			expect(sameStat(disk, base), name).toBe(true);
		}
	});

	it("两边都是浮点、取整后落在同一毫秒 → 相等", () => {
		// 0.1 和 0.4 都向下取整到同一个整数
		expect(sameStat(1792825000985.1, 1792825000985.4)).toBe(true);
		expect(sameStat(1792825000985.49, 1792825000985.4)).toBe(true);
		// 但跨过 .5 就不同了 —— 向上取整是另一毫秒
		expect(sameStat(1792825000985.1, 1792825000985.9)).toBe(false);
	});

	it("真正的改动照样判为不同", () => {
		expect(sameStat(1792825000985, 1792825000986)).toBe(false);
		expect(sameStat(1792825000491, 1792825001491)).toBe(false);
		// 跨毫秒边界就是不同：.6 向上取整成 +1ms
		expect(sameStat(1792825000985, 1792825000986.4)).toBe(false);
	});

	it("缺失值不算相等（不能因为两边都 undefined 就复用 sha）", () => {
		expect(sameStat(undefined, 123)).toBe(false);
		expect(sameStat(123, undefined)).toBe(false);
		expect(sameStat(undefined, undefined)).toBe(false);
	});

	it("normalizeStat 在入口处取整，新写入的值是整数", () => {
		for (const [name, base, disk] of CASES) {
			expect(normalizeStat({ size: 1, mtime: disk }), name).toEqual({
				size: 1,
				mtime: base,
			});
		}
		expect(normalizeStat(null)).toBeNull();
	});
});
