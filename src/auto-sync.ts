// Automatic sync triggers: debounced vault events, a periodic interval,
// startup, and "back to foreground" (document visibility). Auto rounds
// only run after the first explicit successful sync (lastSyncAt set by
// runSync) — the first sync is always a deliberate user action.

import { TFile } from "obsidian";
import { isSyncablePath } from "./sync/vault-io";
import type { VaultIO } from "./sync/vault-io";
import type { SyncState } from "./sync/state";
import type { SyncReport } from "./sync/deps";

export interface AutoSyncSettings {
	autoSync: boolean;
	/** Master hold: no *automatic* round runs while this is true. Manual
	 * commands deliberately still work — "pause" means "stop doing this
	 * behind my back", not "disable the plugin". Optional so older callers
	 * and tests keep compiling; `undefined` reads as "not paused". */
	paused?: boolean;
	autoSyncDebounceSeconds: number;
	autoSyncIntervalMinutes: number;
	syncOnStartup: boolean;
	syncOnForeground: boolean;
}

export interface AutoSyncHost {
	/** plugin.registerEvent / registerInterval / registerDomEvent wrappers */
	registerEvent(ref: unknown): void;
	registerInterval(id: number): void;
	registerDomEvent(
		el: Document,
		type: string,
		cb: (ev: Event) => void,
	): void;
	onVaultEvent(
		type: "modify" | "create" | "delete" | "rename",
		/** `isFolder` is true for directory-level events: those move a whole
		 * subtree at once, and a per-file view of them is not trustworthy. */
		cb: (path: string, oldPath?: string, isFolder?: boolean) => void,
	): unknown;
	onLayoutReady(cb: () => void): void;
}

export interface AutoSyncHooks {
	getSettings(): AutoSyncSettings;
	getState(): SyncState | null;
	getVaultIO(): VaultIO | null;
	/** configDir (e.g. ".obsidian") — events inside it are ignored. */
	configDir(): string;
	/** run one auto round; resolves with the report.
	 *
	 * `forceAudit` asks the engine to re-enumerate the whole remote tree this
	 * round. It is set after a DIRECTORY-level rename or delete: one such
	 * event moves an entire subtree, the per-file rename hints that carry
	 * that across rounds can be lost (event before layout-ready, plugin
	 * reload, a dropped debounce), and an incremental round against stale
	 * remote metadata then decides "local subtree gone" and trashes the
	 * remote pages. A directory operation is rare; a full enumeration is
	 * cheap next to re-creating pages the other device can never find again. */
	request(opts?: {
		forceAudit?: boolean;
		/** A "light" round skips the full remote structure scan — used for
		 * debounced edit triggers, which fire every pause in typing and do
		 * not need a workspace-wide /search to push one changed note. */
		light?: boolean;
	}): Promise<SyncReport>;
	/** called on every relevant vault change, before the debounce fires:
	 * lets the host keep the "pending changes" list honest without a second
	 * event subscription (and without a second debounce timer). */
	onChange?(path: string): void;
	/** called with each auto round's report (silent handling lives in main). */
	onReport?(report: SyncReport): void;
	/** called when an automatic round REJECTED (token, network, a write that
	 * could not be verified). Without it a failed round is a silent no-op in
	 * the panel, which is exactly the state where "sync keeps running" is
	 * impossible to diagnose. */
	onError?(err: unknown): void;
	/** Host-side "a round is in flight" flag. The trigger side keeps its own
	 * flag; this one covers rounds started by a COMMAND, which the triggers
	 * must not pile a second round onto. */
	isSyncing?(): boolean;
	/** Persist a round's end time even when it FAILED. `state.lastSyncAt` is
	 * written by a completed round only, so without this hook a failing
	 * round never advances the clock 鈥?and the interval check, which reads
	 * `now - lastSyncAt`, fires again on the next minute tick. Forever. */
	onRoundEnd?(at: number): void;
	setTimeoutFn?(cb: () => void, ms: number): number;
	clearTimeoutFn?(id: number): void;
	setIntervalFn?(cb: () => void, ms: number): number;
	now?(): number;
}

/** When the last round ended, whatever its outcome. `lastSyncAt` only
 * advances on a completed round, so gating on it makes a device that keeps
 * failing retry on every minute tick; `lastRoundAt` is the honest clock. */
export function lastRoundEnd(state: SyncState | null): number | undefined {
	const a = state?.lastRoundAt;
	const b = state?.lastSyncAt;
	if (a === undefined) return b;
	if (b === undefined) return a;
	// `lastRoundAt` is only written by FAILED rounds; preferring it outright
	// froze the clock at the last failure and fired a round every minute.
	return Math.max(a, b);
}

/** Auto triggers require a completed manual sync on this device and that
 * the user hasn't paused them. */
export function autoSyncAllowed(
	settings: AutoSyncSettings,
	state: SyncState | null,
): boolean {
	return (
		settings.autoSync &&
		!settings.paused &&
		state?.lastSyncAt !== undefined
	);
}

/** Can automatic sync run at all (regardless of whether a first manual round
 * happened)? Used by the ribbon/tooltips, which must show "paused" even
 * before the first sync. */
export function shouldAutoRun(settings: AutoSyncSettings): boolean {
	return settings.autoSync && !settings.paused;
}

/** Paths that never trigger auto-sync: dot segments, .trash, configDir. */
export function autoSyncIgnoresPath(path: string, configDir: string): boolean {
	if (!isSyncablePath(path)) return true;
	const dir = configDir.replace(/^\/+|\/+$/g, "");
	return dir !== "" && (path === dir || path.startsWith(`${dir}/`));
}

export function wireAutoSync(
	host: AutoSyncHost,
	hooks: AutoSyncHooks,
): void {
	const setTimeoutFn =
		hooks.setTimeoutFn ??
		((cb: () => void, ms: number) => window.setTimeout(cb, ms));
	const clearTimeoutFn =
		hooks.clearTimeoutFn ?? ((id: number) => window.clearTimeout(id));
	const setIntervalFn =
		hooks.setIntervalFn ??
		((cb: () => void, ms: number) => window.setInterval(cb, ms));
	const now = hooks.now ?? (() => Date.now());

	/** Set when a directory-level rename/delete landed inside the current
	 * debounce window. Consumed by the round it triggers. */
	let pendingForceAudit = false;

	/** One round at a time, as seen by the TRIGGERS.
	 *
	 * SyncRunner already coalesces concurrent requests, but that is not enough
	 * here: the interval check reads `now - lastSyncAt`, and a round that takes
	 * longer than the interval leaves the clock stale for its whole duration, so
	 * every minute tick fires again and folds into a pending round. The result
	 * is a device that never stops syncing. The flag is cleared in the promise
	 * tail, so a rejected round releases it too. */
	let running = false;
	const busy = (): boolean => running || hooks.isSyncing?.() === true;

	const fire = (light = false) => {
		if (busy()) return;
		if (!autoSyncAllowed(hooks.getSettings(), hooks.getState())) return;
		const forceAudit = pendingForceAudit;
		pendingForceAudit = false;
		running = true;
		void hooks
			.request(
				forceAudit
					? { forceAudit: true }
					: light
						? { light: true }
						: undefined,
			)
			.then(
				(r) => {
					// A completed round already stamped `lastSyncAt` itself.
					running = false;
					hooks.onReport?.(r);
				},
				(err: unknown) => {
					// A round that threw still ENDED. Not advancing the clock here
					// is what turned one failure into a round every minute.
					running = false;
					hooks.onRoundEnd?.(now());
					hooks.onError?.(err);
				},
			);
	};

	let timer: number | null = null;
	const armTimer = () => {
		timer = setTimeoutFn(() => {
			timer = null;
			if (busy()) {
				// A round is in flight — the edit that armed this timer must
				// not wait for the next 10-minute interval. Re-arm the same
				// debounce so a light round fires shortly after it ends.
				armTimer();
				return;
			}
			// An edit-triggered round only needs to push what changed — the
			// full remote structure scan is wasted work every pause in typing.
			fire(true);
		}, Math.max(1, hooks.getSettings().autoSyncDebounceSeconds) * 1000);
	};
	const schedule = () => {
		if (!autoSyncAllowed(hooks.getSettings(), hooks.getState())) return;
		if (timer !== null) clearTimeoutFn(timer);
		armTimer();
	};

	const relevant = (path: string) =>
		!autoSyncIgnoresPath(path, hooks.configDir());
	const ours = (path: string) =>
		hooks.getVaultIO()?.writes.consume(path, path) ?? false;

	for (const type of ["modify", "create", "delete"] as const) {
		host.registerEvent(
			host.onVaultEvent(type, (path, _old, isFolder) => {
				if (!relevant(path) || ours(path)) return;
				// A deleted directory takes its subtree with it; the per-file
				// view cannot be reconciled incrementally.
				if (type === "delete" && isFolder) pendingForceAudit = true;
				hooks.onChange?.(path);
				schedule();
			}),
		);
	}
	host.registerEvent(
		host.onVaultEvent("rename", (path, oldPath, isFolder) => {
			if (!relevant(path) || ours(path)) return;
			// Same reasoning as the delete case: a renamed directory is one
			// subtree moving, and its rename hint is the only thing that makes
			// the base paths line up next round.
			if (isFolder) pendingForceAudit = true;
			hooks.onChange?.(path);
			schedule();
		}),
	);

	// periodic interval — reads current settings each minute
	host.registerInterval(
		setIntervalFn(() => {
			const s = hooks.getSettings();
			const min = s.autoSyncIntervalMinutes;
			if (min <= 0) return;
			if (busy()) return; // a round longer than the interval must not chain
			const last = lastRoundEnd(hooks.getState());
			if (last === undefined) return;
			if (now() - last >= min * 60_000) fire();
		}, 60_000),
	);

	host.onLayoutReady(() => {
		setTimeoutFn(() => {
			if (hooks.getSettings().syncOnStartup) fire();
		}, 5000);
	});

	if (typeof document !== "undefined") {
		host.registerDomEvent(document, "visibilitychange", () => {
			if (document.hidden || !hooks.getSettings().syncOnForeground)
				return;
			if (busy()) return;
			const last = lastRoundEnd(hooks.getState());
			if (last === undefined) return;
			// Coming back to the app is not a reason to sync when a round ran
			// recently: on a phone `visibilitychange` fires on every app switch,
			// lock/unlock and tab return, so a fixed 60 s gate produced dozens
			// of rounds a day. Honour the user's interval instead — it already
			// expresses "how often may this talk to Notion".
			const intervalMin = hooks.getSettings().autoSyncIntervalMinutes;
			const gateMin = intervalMin > 0 ? intervalMin : 10;
			if (now() - last <= gateMin * 60_000) return;
			fire();
		});
	}
}

/** Convenience for main.ts: filter helper for raw Obsidian TAbstractFile. */
export function filePathOf(f: unknown): string | null {
	return f instanceof TFile ? f.path : null;
}
