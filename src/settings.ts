import {
	defaultConfigSync,
	type ConfigSyncSettings,
} from "./config/filter";

/**
 * Files re-checked for remote content changes every round.
 *
 * Not user-configurable on purpose: this is a correctness backstop, not a
 * tuning knob. Notion pushes no change events, `last_edited_time` is
 * minute-rounded (a human edit in the same minute as our own write leaves
 * the timestamp unchanged, so the /search gate skips it), and the full
 * audit only compares structure — never content. Downloading and hashing
 * every file each round would cost ~2 requests per file (1000 files ≈ 11
 * minutes at Notion's 3 req/s), so the work is spread across rounds.
 *
 * 10 files/round ≈ 20 requests ≈ 7s, and covers a 100-file vault in ~10
 * rounds. Exposed as a const rather than a setting so users never have to
 * reason about it.
 */
export const ROUND_ROBIN_PER_ROUND = 10;

export interface NotionHubSettings {
	token: string;
	rootPage: string;
	deviceId: string;
	/** "auto" follows Obsidian's language; otherwise "en" / "zh-CN". */
	language: string;
	historyEnabled: boolean;
	historyIntervalMinutes: number;
	historyMaxVersions: number;
	historyRetentionDays: number;
	fullAuditHours: number;
	configSync: ConfigSyncSettings;
	autoSync: boolean;
	autoSyncDebounceSeconds: number;
	autoSyncIntervalMinutes: number;
	syncOnStartup: boolean;
	syncOnForeground: boolean;
	maxFileSizeMB: number;
	/** prompt before this many local deletions in one round (0 = off). */
	deleteGuardThreshold: number;
}

export const DEFAULT_SETTINGS: NotionHubSettings = {
	token: "",
	rootPage: "",
	deviceId: "",
	language: "auto",
	historyEnabled: true,
	historyIntervalMinutes: 10,
	historyMaxVersions: 50,
	historyRetentionDays: 30,
	fullAuditHours: 6,
	configSync: defaultConfigSync(),
	autoSync: true,
	autoSyncDebounceSeconds: 10,
	autoSyncIntervalMinutes: 5,
	syncOnStartup: true,
	syncOnForeground: true,
	maxFileSizeMB: 200,
	deleteGuardThreshold: 10,
};
