import type { NotionClient } from "../notion/client";
import type { VaultIO } from "./vault-io";
import type { SyncState } from "./state";
import type { BlockedPath } from "./blocked";
import type { Scope } from "./scope";

export interface HistorySettings {
	enabled: boolean;
	intervalMinutes: number;
	maxVersions: number;
	retentionDays: number;
}

/** Round phases, in execution order. The panel shows one line per phase,
 * so a stuck round can be told apart from a slow one: "download" running
 * for a minute is a big file, "scanRemote" for a minute is the API. */
export type SyncPhase =
	| "scanLocal"
	| "scanRemote"
	| "plan"
	| "download"
	| "upload"
	| "apply"
	| "config"
	| "journal";

/** Fine-grained activity inside a phase, for the indeterminate bar. */
export type SyncStage =
	| "hashing"
	| "walking"
	| "evaluating"
	| "downloading"
	| "uploading"
	| "applying"
	| "config";

/** Structured activity events emitted during a sync round (panel/log). */
export type SyncEvent =
	| { t: "phase"; phase: SyncPhase; count?: number }
	| {
			t: "action";
			action: string;
			path: string;
			done: number;
			total: number;
			/** false when the action failed (actionFailed carries the detail). */
			ok: boolean;
	  }
	| {
			t: "scan";
			stage: "local" | "walk" | "evaluate";
			done: number;
			total?: number;
			label: string;
	  }
	| { t: "actionFailed"; action: string; path: string; error: string }
	| {
			t: "upload";
			path: string;
			part: number;
			parts: number;
			bytes: number;
	  }
	/** Progress *within* one action (a download in flight). `total` is null
	 * when the size is unknown, e.g. a multipart part list still being built. */
	| {
			t: "stage";
			stage: SyncStage;
			label: string;
			done?: number;
			total?: number;
			/** extra lines shown under the label (active paths) */
			active?: string[];
	  };

export interface SyncDeps {
	vault: VaultIO;
	client: NotionClient;
	state: SyncState;
	saveState(): Promise<void>;
	/** Obsidian link target → vault path (e.g. via metadataCache), or null. */
	resolvePath(target: string, sourcePath: string): string | null;
	deviceId: string;
	history?: HistorySettings;
	/** pageId (hex32 title) → history page id; cached once per run. */
	historyPageCache?: Map<string, string>;
	now?: () => number;
	/** Milestone diagnostics: one line per phase / per round, plus every
	 * decision a maintainer needs to reconstruct what a round did (journal
	 * read, audit outcome, plan summary, adopt/skip decisions). Bounded per
	 * round — never one line per file. */
	log?: (msg: string) => void;
	/** Per-item detail (each file hashed, each action applied). Off by
	 * default: a 2000-file vault would bury the milestones above. */
	debug?: (msg: string) => void;
	progress?: (done: number, total: number, label: string) => void;
	event?: (ev: SyncEvent) => void;
	/** Which paths this device syncs. Set once per round by `runSync`; the
	 * scanners and the planner read the same instance. */
	scope?: Scope;
	/** Bounds in-flight memory (mobile is far tighter). */
	isMobile?: boolean;
}

export interface SyncReport {
	created: number;
	updated: number;
	skipped: number;
	failed: number;
	failures: string[];
	/** Non-fatal issues (e.g. version write failures). */
	warnings: string[];
	/** Set when config files were written locally → suggest a reload. */
	configWritten?: boolean;
	/** Local conflict copies created this round (vault paths). */
	conflictCopies: string[];
	/** Files skipped by policy, with the reason. Always surfaced in the UI:
	 * a silently skipped file looks exactly like a synced one. */
	blocked: BlockedPath[];
}

export function newReport(): SyncReport {
	return {
		created: 0,
		updated: 0,
		skipped: 0,
		failed: 0,
		failures: [],
		warnings: [],
		conflictCopies: [],
		blocked: [],
	};
}
