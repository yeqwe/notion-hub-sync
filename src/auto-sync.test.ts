import { describe, expect, it } from "vitest";
import {
	autoSyncAllowed,
	autoSyncIgnoresPath,
	wireAutoSync,
	type AutoSyncHooks,
	type AutoSyncHost,
} from "./auto-sync";
import { emptyState } from "./sync/state";
import { newReport } from "./sync/deps";
import { RenameTracker } from "./sync/rename-tracker";

const settings = {
	autoSync: true,
	autoSyncDebounceSeconds: 10,
	autoSyncIntervalMinutes: 5,
	syncOnStartup: true,
	syncOnForeground: true,
};

describe("autoSyncAllowed", () => {
	it("requires autoSync on AND a completed first sync", () => {
		const st = emptyState("r");
		expect(autoSyncAllowed(settings, st)).toBe(false);
		st.lastSyncAt = 1;
		expect(autoSyncAllowed(settings, st)).toBe(true);
		expect(autoSyncAllowed({ ...settings, autoSync: false }, st)).toBe(
			false,
		);
		expect(autoSyncAllowed(settings, null)).toBe(false);
	});
});

describe("autoSyncIgnoresPath", () => {
	it("ignores dot segments, .trash and the config dir", () => {
		expect(autoSyncIgnoresPath("a.md", ".obsidian")).toBe(false);
		expect(autoSyncIgnoresPath(".hidden/x.md", ".obsidian")).toBe(true);
		expect(autoSyncIgnoresPath(".trash/x.md", ".obsidian")).toBe(true);
		expect(autoSyncIgnoresPath(".obsidian/app.json", ".obsidian")).toBe(true);
		expect(autoSyncIgnoresPath(".obsidian", ".obsidian")).toBe(true);
		expect(autoSyncIgnoresPath("obsidianx/a.md", ".obsidian")).toBe(false);
	});
});

function harness(overrides?: Partial<AutoSyncHooks>) {
	const calls: string[] = [];
	const timers = new Map<number, () => void>();
	let nextTimer = 1;
	let intervalCb: (() => void) | null = null;
	const vaultCallbacks = new Map<
		string,
		(path: string, old?: string) => void
	>();
	const state = emptyState("r");
	state.lastSyncAt = 1000;
	const writes = new RenameTracker();
	const hooks: AutoSyncHooks = {
		getSettings: () => settings,
		getState: () => state,
		getVaultIO: () => ({ writes }) as never,
		configDir: () => ".obsidian",
		request: async () => {
			calls.push("request");
			return newReport();
		},
		setTimeoutFn: (cb) => {
			const id = nextTimer++;
			timers.set(id, cb);
			return id;
		},
		clearTimeoutFn: (id) => void timers.delete(id),
		setIntervalFn: (cb) => {
			intervalCb = cb;
			return 99;
		},
		now: () => 1_000_000,
		...overrides,
	};
	const host: AutoSyncHost = {
		registerEvent: () => {},
		registerInterval: () => {},
		registerDomEvent: () => {},
		onVaultEvent: (type, cb) => {
			vaultCallbacks.set(type, cb);
			return {};
		},
		onLayoutReady: () => {},
	};
	wireAutoSync(host, hooks);
	const fireTimer = () => {
		for (const cb of [...timers.values()]) cb();
		timers.clear();
	};
	return { calls, timers, fireTimer, vaultCallbacks, state, writes, runInterval: () => intervalCb?.() };
}

describe("wireAutoSync", () => {
	it("debounces vault events into one request", () => {
		const h = harness();
		h.vaultCallbacks.get("modify")!("a.md");
		h.vaultCallbacks.get("create")!("b.md");
		h.vaultCallbacks.get("delete")!("c.md");
		expect(h.timers.size).toBe(1); // coalesced
		h.fireTimer();
		expect(h.calls).toEqual(["request"]);
	});

	it("ignores engine-caused writes and excluded paths", () => {
		const h = harness();
		h.writes.expect("eng.md", "eng.md");
		h.vaultCallbacks.get("modify")!("eng.md");
		h.vaultCallbacks.get("modify")!(".obsidian/app.json");
		expect(h.timers.size).toBe(0);
	});

	it("no timer when not yet synced once", () => {
		const h = harness();
		h.state.lastSyncAt = undefined;
		h.vaultCallbacks.get("modify")!("a.md");
		expect(h.timers.size).toBe(0);
	});

	it("interval fires only when due", () => {
		const h = harness({ now: () => 1_000_000 });
		h.state.lastSyncAt = 1_000_000 - 60_000; // 1 min ago < 5 min interval
		h.runInterval();
		expect(h.calls).toEqual([]);
		h.state.lastSyncAt = 1_000_000 - 6 * 60_000;
		h.runInterval();
		expect(h.calls).toEqual(["request"]);
	});
});
