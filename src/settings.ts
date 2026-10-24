import {
	defaultConfigSync,
	type ConfigSyncSettings,
} from "./config/filter";
import {
	defaultScope,
	normalizeScope,
	type ScopeSettings,
} from "./sync/scope";

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
	/** Scan the whole remote STRUCTURE every round (`POST /search`, ~1 request
	 * per 100 pages). On by default: it is what turns "the page is probably
	 * still there" into an observation, and it replaced the per-entry
	 * round-robin GETs, so an idle round is CHEAPER with it on. Off restores
	 * the old journal-only behaviour, including its blind spot. */
	scanStructureEveryRound: boolean;
	configSync: ConfigSyncSettings;
	/** Which file types / folders sync. Notes always sync. */
	scope: ScopeSettings;
	autoSync: boolean;
	/** Master off-switch for *automatic* rounds. Manual commands still run:
	 * "pause" means "stop doing this behind my back", not "uninstall". */
	paused: boolean;
	autoSyncDebounceSeconds: number;
	autoSyncIntervalMinutes: number;
	syncOnStartup: boolean;
	syncOnForeground: boolean;
	maxFileSizeMB: number;
	/** prompt before this many local deletions in one round (0 = off). */
	deleteGuardThreshold: number;
	/** Verbose per-item diagnostics to the developer console. Never touches
	 * the sync panel — that channel is for milestones only. */
	debugLog: boolean;
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
	scanStructureEveryRound: true,
	configSync: defaultConfigSync(),
	scope: defaultScope(),
	autoSync: true,
	paused: false,
	autoSyncDebounceSeconds: 10,
	autoSyncIntervalMinutes: 10,
	syncOnStartup: true,
	/** Foreground sync is OFF by default: on a phone this fires on every app
	 * switch, screen unlock and tab return — dozens of rounds a day, each one
	 * a handful of Notion requests. The 10-minute interval already covers "I
	 * came back to work", and the ribbon button is one tap away. Turn it on
	 * if you want an immediate round on unlock. */
	syncOnForeground: false,
	maxFileSizeMB: 200,
	deleteGuardThreshold: 10,
	debugLog: false,
};

/** Merge persisted settings over the defaults, normalizing nested objects
 * so a key added in a later version cannot arrive undefined. */
export function mergeSettings(
	saved: Partial<NotionHubSettings> | null | undefined,
): NotionHubSettings {
	const src = saved ?? {};
	return {
		...DEFAULT_SETTINGS,
		...src,
		configSync: { ...DEFAULT_SETTINGS.configSync, ...(src.configSync ?? {}) },
		scope: normalizeScope(src.scope),
	};
}
