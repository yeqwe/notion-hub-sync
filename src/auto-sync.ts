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
		cb: (path: string, oldPath?: string) => void,
	): unknown;
	onLayoutReady(cb: () => void): void;
}

export interface AutoSyncHooks {
	getSettings(): AutoSyncSettings;
	getState(): SyncState | null;
	getVaultIO(): VaultIO | null;
	/** configDir (e.g. ".obsidian") — events inside it are ignored. */
	configDir(): string;
	/** run one auto round; resolves with the report. */
	request(): Promise<SyncReport>;
	/** called with each auto round's report (silent handling lives in main). */
	onReport?(report: SyncReport): void;
	setTimeoutFn?(cb: () => void, ms: number): number;
	clearTimeoutFn?(id: number): void;
	setIntervalFn?(cb: () => void, ms: number): number;
	now?(): number;
}

/** Auto triggers require a completed manual sync on this device. */
export function autoSyncAllowed(
	settings: AutoSyncSettings,
	state: SyncState | null,
): boolean {
	return settings.autoSync && state?.lastSyncAt !== undefined;
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

	const fire = () => {
		if (!autoSyncAllowed(hooks.getSettings(), hooks.getState())) return;
		void hooks.request().then((r) => hooks.onReport?.(r));
	};

	let timer: number | null = null;
	const schedule = () => {
		if (!autoSyncAllowed(hooks.getSettings(), hooks.getState())) return;
		if (timer !== null) clearTimeoutFn(timer);
		timer = setTimeoutFn(() => {
			timer = null;
			fire();
		}, Math.max(1, hooks.getSettings().autoSyncDebounceSeconds) * 1000);
	};

	const relevant = (path: string) =>
		!autoSyncIgnoresPath(path, hooks.configDir());
	const ours = (path: string) =>
		hooks.getVaultIO()?.writes.consume(path, path) ?? false;

	for (const type of ["modify", "create", "delete"] as const) {
		host.registerEvent(
			host.onVaultEvent(type, (path) => {
				if (relevant(path) && !ours(path)) schedule();
			}),
		);
	}
	host.registerEvent(
		host.onVaultEvent("rename", (path) => {
			if (relevant(path) && !ours(path)) schedule();
		}),
	);

	// periodic interval — reads current settings each minute
	host.registerInterval(
		setIntervalFn(() => {
			const s = hooks.getSettings();
			const min = s.autoSyncIntervalMinutes;
			if (min <= 0) return;
			const last = hooks.getState()?.lastSyncAt;
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
			const last = hooks.getState()?.lastSyncAt;
			if (last === undefined || now() - last <= 60_000) return;
			fire();
		});
	}
}

/** Convenience for main.ts: filter helper for raw Obsidian TAbstractFile. */
export function filePathOf(f: unknown): string | null {
	return f instanceof TFile ? f.path : null;
}
