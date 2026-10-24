// "It syncs too often" — a round costs Notion requests even when nothing
// changed, so the defaults and the foreground gate both have to be conservative.

import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "./settings";
import { lastRoundEnd, autoSyncAllowed, shouldAutoRun } from "./auto-sync";

describe("同步频率的默认值", () => {
	it("默认 10 分钟一轮", () => {
		expect(DEFAULT_SETTINGS.autoSyncIntervalMinutes).toBe(10);
	});

	it("前台同步默认关闭（手机上每次切 App 都会触发）", () => {
		expect(DEFAULT_SETTINGS.syncOnForeground).toBe(false);
	});

	it("老配置文件没有这两个键时，合并后拿到新默认值", () => {
		// A data.json written by 0.5.x has no syncOnForeground change and an
		// interval of 5; mergeSettings must not resurrect the old number for a
		// key that is simply absent, and must keep an explicit value.
		const merged = mergeSettings({ autoSyncDebounceSeconds: 10 });
		expect(merged.autoSyncIntervalMinutes).toBe(10);
		expect(merged.syncOnForeground).toBe(false);
		// an explicit choice is preserved
		const kept = mergeSettings({ autoSyncIntervalMinutes: 30 });
		expect(kept.autoSyncIntervalMinutes).toBe(30);
	});
});

describe("定时器与失败轮次的时钟", () => {
	it("失败的一轮也算结束，否则每分钟都会重试", () => {
		const state = {
			version: 1 as const,
			rootPageId: "r",
			entries: {},
			lastSyncAt: 1000,
			lastRoundAt: 5000,
		};
		expect(lastRoundEnd(state)).toBe(5000);
		// a state that only ever succeeded still reports a clock
		expect(lastRoundEnd({ ...state, lastRoundAt: undefined })).toBe(1000);
		expect(lastRoundEnd(null)).toBeUndefined();
	});

	it("一次失败之后的成功轮次照常推进时钟（不能卡在失败那一刻）", () => {
		// 真实现场：13:13 一轮 ERR_CONNECTION_RESET 写下 lastRoundAt，之后
		// 每轮都成功，但 lastRoundEnd 一直返回 13:13 → 每分钟都触发一轮。
		const state = {
			version: 1 as const,
			rootPageId: "r",
			entries: {},
			lastRoundAt: 1000,
			lastSyncAt: 9000,
		};
		expect(lastRoundEnd(state)).toBe(9000);
	});

	it("暂停时不跑自动轮，手动仍可", () => {
		const s = {
			autoSync: true,
			paused: true,
			autoSyncDebounceSeconds: 10,
			autoSyncIntervalMinutes: 10,
			syncOnStartup: true,
			syncOnForeground: false,
		};
		expect(shouldAutoRun(s)).toBe(false);
		expect(autoSyncAllowed(s, null)).toBe(false);
		const on = { ...s, paused: false };
		expect(shouldAutoRun(on)).toBe(true);
		// still needs a first successful manual sync on this device
		expect(autoSyncAllowed(on, null)).toBe(false);
		expect(
			autoSyncAllowed(on, {
				version: 1,
				rootPageId: "r",
				entries: {},
				lastSyncAt: 1,
			}),
		).toBe(true);
	});
});
