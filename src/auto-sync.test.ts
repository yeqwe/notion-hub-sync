import { describe, expect, it } from "vitest";
import {
	autoSyncAllowed,
	autoSyncIgnoresPath,
	lastRoundEnd,
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
	/** forceAudit flag of each round that actually fired, in order. */
	const forceAudit: boolean[] = [];
	/** light flag of each round that actually fired, in order. */
	const lights: boolean[] = [];
	const timers = new Map<number, () => void>();
	let nextTimer = 1;
	let intervalCb: (() => void) | null = null;
	const vaultCallbacks = new Map<
		string,
		(path: string, old?: string, isFolder?: boolean) => void
	>();
	const state = emptyState("r");
	state.lastSyncAt = 1000;
	/** rounds that ended, in order (success AND failure). */
	const roundEnds: number[] = [];
	const errors: unknown[] = [];
	const writes = new RenameTracker();
	const hooks: AutoSyncHooks = {
		getSettings: () => settings,
		getState: () => state,
		getVaultIO: () => ({ writes }) as never,
		configDir: () => ".obsidian",
		onRoundEnd: (at) => {
			roundEnds.push(at);
			state.lastRoundAt = at; // what main.ts does
		},
		onError: (err) => errors.push(err),
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
		// last, so an override cannot bypass the call recording
		request: async (opts) => {
			calls.push("request");
			forceAudit.push(opts?.forceAudit ?? false);
			lights.push(opts?.light ?? false);
			return overrides?.request
				? overrides.request(opts)
				: newReport();
		},
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
	return {
		calls,
		timers,
		fireTimer,
		vaultCallbacks,
		state,
		writes,
		forceAudit,
		lights,
		roundEnds,
		errors,
		runInterval: () => intervalCb?.(),
	};
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

	it("an edit-triggered round is light; the interval round is not", async () => {
		// Typing pauses fire every few seconds — those rounds must not pay
		// for a workspace-wide structure scan. The 10-min interval can.
		const h = harness({ now: () => 1_000_000 });
		h.vaultCallbacks.get("modify")!("a.md");
		h.fireTimer();
		await Promise.resolve();
		await Promise.resolve(); // let the round's promise tail clear `running`
		expect(h.lights).toEqual([true]);

		h.state.lastSyncAt = 1_000_000 - 6 * 60_000;
		h.runInterval();
		await Promise.resolve();
		expect(h.calls).toEqual(["request", "request"]);
		expect(h.lights).toEqual([true, false]);
	});

	it("a forced audit is never light", async () => {
		const h = harness();
		h.vaultCallbacks.get("delete")!("OldDir", undefined, true);
		h.fireTimer();
		await Promise.resolve();
		expect(h.forceAudit).toEqual([true]);
		expect(h.lights).toEqual([false]);
	});

	it("a directory event upgrades the round to a full audit", () => {
		// One rename moves a whole subtree; if the per-file hints do not line
		// up, an incremental round reads "local subtree gone" and trashes the
		// remote pages. A directory operation is rare, so paying for a full
		// enumeration is cheaper than re-creating pages the other device can
		// never find again.
		const h = harness();
		h.vaultCallbacks.get("rename")!("New", "Old", true);
		h.fireTimer();
		expect(h.calls).toEqual(["request"]);
		expect(h.forceAudit).toEqual([true]);
	});

	it("a deleted directory also upgrades the round", () => {
		const h = harness();
		h.vaultCallbacks.get("delete")!("OldDir", undefined, true);
		h.fireTimer();
		expect(h.forceAudit).toEqual([true]);
	});

	it("plain file events stay incremental", () => {
		const h = harness();
		h.vaultCallbacks.get("modify")!("a.md", undefined, false);
		h.vaultCallbacks.get("rename")!("b.md", "a.md", false);
		h.fireTimer();
		expect(h.forceAudit).toEqual([false]);
	});

	it("the force flag is consumed by the round it triggered", async () => {
		const h = harness();
		h.vaultCallbacks.get("rename")!("New", "Old", true);
		h.fireTimer();
		await Promise.resolve();
		h.vaultCallbacks.get("modify")!("a.md");
		h.fireTimer();
		await Promise.resolve();
		expect(h.forceAudit).toEqual([true, false]);
	});
});

describe("no self-feeding rounds", () => {
	// The reported symptom: an interval is configured, yet the device syncs
	// continuously. Both causes below are about a round that is still running
	// or that failed, being treated as "time to start another".

	it("a slow round does not chain into another one", async () => {
		// A round longer than the interval leaves lastSyncAt stale for its
		// whole duration. Every minute tick used to fire again and fold into
		// a pending round, so the next round started the instant this one
		// finished 闁?forever.
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const h = harness({
			request: async () => {
				await gate;
				return newReport();
			},
		});
		h.state.lastSyncAt = 0; // long overdue
		h.vaultCallbacks.get("modify")!("a.md");
		h.fireTimer();
		await Promise.resolve();
		expect(h.calls.length).toBe(1);
		// ticks arrive while the round is in flight
		h.runInterval();
		h.runInterval();
		expect(h.calls.length).toBe(1);
		release();
		await Promise.resolve();
		await Promise.resolve();
	});

	it("a failing round still ends, so the clock advances", async () => {
		// A rejected request is an async rejection: the settle path runs in a
		// microtask, so the assertions have to await it too.
		const h = harness({
			request: async () => {
				throw new Error("boom");
			},
		});
		h.state.lastSyncAt = 0;
		h.vaultCallbacks.get("modify")!("a.md");
		h.fireTimer();
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(h.errors.length).toBe(1); // surfaced, not swallowed
		expect(h.roundEnds).toEqual([1_000_000]); // clock advanced
		// and the next tick no longer sees an overdue interval
		h.runInterval();
		expect(h.calls.length).toBe(1);
	});

	it("edits during a round do not stack a debounce timer", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const h = harness({
			request: async () => {
				await gate;
				return newReport();
			},
		});
		h.vaultCallbacks.get("modify")!("a.md");
		h.fireTimer();
		await Promise.resolve();
		expect(h.calls.length).toBe(1);
		h.vaultCallbacks.get("modify")!("b.md");
		expect(h.timers.size).toBe(0);
		release();
		await Promise.resolve();
		await Promise.resolve();
	});

	it("a round started by a command also blocks the triggers", () => {
		let syncing = true;
		const h = harness({ isSyncing: () => syncing });
		h.state.lastSyncAt = 0;
		h.runInterval();
		expect(h.calls).toEqual([]);
		syncing = false;
		h.runInterval();
		expect(h.calls).toEqual(["request"]);
	});
});

describe("lastRoundEnd", () => {
	it("prefers the round-end clock, falls back to lastSyncAt", () => {
		const st = emptyState("r");
		expect(lastRoundEnd(st)).toBeUndefined();
		st.lastSyncAt = 10;
		expect(lastRoundEnd(st)).toBe(10);
		st.lastRoundAt = 20; // a failed round after it
		expect(lastRoundEnd(st)).toBe(20);
		expect(lastRoundEnd(null)).toBeUndefined();
	});
});
