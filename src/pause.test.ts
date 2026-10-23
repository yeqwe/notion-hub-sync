// Pause + ribbon label. Two behaviours worth pinning:
//
//  • pausing stops *automatic* rounds only — a manual "sync now" must keep
//    working, otherwise the button is a trap;
//  • the ribbon tooltip must never say "all synced" while something is
//    actually pending, blocked or conflicting. A green tick over a stuck
//    file is worse than no indicator at all.

import { describe, expect, it } from "vitest";
import { autoSyncAllowed, shouldAutoRun } from "./auto-sync";
import { emptyState } from "./sync/state";

const base = {
	autoSync: true,
	paused: false,
	autoSyncDebounceSeconds: 10,
	autoSyncIntervalMinutes: 5,
	syncOnStartup: true,
	syncOnForeground: true,
};

function started() {
	const st = emptyState("r");
	st.lastSyncAt = 1;
	return st;
}

describe("pause", () => {
	it("blocks automatic rounds", () => {
		const st = started();
		expect(autoSyncAllowed(base, st)).toBe(true);
		expect(autoSyncAllowed({ ...base, paused: true }, st)).toBe(false);
	});

	it("still requires a completed first sync", () => {
		expect(autoSyncAllowed(base, emptyState("r"))).toBe(false);
	});

	it("treats a missing flag as not paused (older data.json)", () => {
		const st = started();
		const legacy = { ...base } as Record<string, unknown>;
		delete legacy.paused;
		expect(autoSyncAllowed(legacy as never, st)).toBe(true);
	});

	it("shouldAutoRun ignores the first-sync gate", () => {
		// the ribbon must be able to say "paused" even before the first sync
		expect(shouldAutoRun(base)).toBe(true);
		expect(shouldAutoRun({ ...base, paused: true })).toBe(false);
		expect(shouldAutoRun({ ...base, autoSync: false })).toBe(false);
	});
});
