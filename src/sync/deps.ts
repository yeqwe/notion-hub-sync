import type { NotionClient } from "../notion/client";
import type { VaultIO } from "./vault-io";
import type { SyncState } from "./state";

export interface HistorySettings {
	enabled: boolean;
	intervalMinutes: number;
	maxVersions: number;
	retentionDays: number;
}

export type SyncPhase =
	| "scanLocal"
	| "scanRemote"
	| "plan"
	| "config"
	| "journal";

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
	log?: (msg: string) => void;
	progress?: (done: number, total: number, label: string) => void;
	event?: (ev: SyncEvent) => void;
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
	/** Files skipped by policy (e.g. above maxFileSizeMB). */
	blocked: string[];
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
