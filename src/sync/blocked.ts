// Why a file was not synced this round, and how to say it to a user.
//
// `SyncReport.blocked` used to be `string[]`, which forced every caller to
// invent its own wording and made the panel unable to group anything. A
// reason code keeps the wording in one place (here) while the struct stays
// cheap to build in the engine.

export type BlockedReason =
	/** Above `maxFileSizeMB` — skipped on purpose. */
	| "oversized"
	/** Remote content above the limit: not downloaded, not deleted. */
	| "remoteOversized"
	/** The local file could not be read or hashed. */
	| "readFailed"
	/** Two paths differ only by case — one physical file on
	 * case-insensitive filesystems (Windows, macOS default). */
	| "caseConflict";

export interface BlockedPath {
	path: string;
	reason: BlockedReason;
	/** Detail for the log line (error text, size, the twin path). */
	detail?: string;
}

export const BLOCKED_REASONS: readonly BlockedReason[] = [
	"oversized",
	"remoteOversized",
	"readFailed",
	"caseConflict",
];

export interface BlockedSummary {
	count: number;
	/** Headline, e.g. "3 个文件未同步"; empty when nothing is blocked. */
	headline: string;
	/** Ready-to-show detail block (one to three lines); empty when none. */
	detail: string;
	/** Per-path rows, de-duplicated, in input order. */
	files: Array<BlockedPath & { label: string }>;
}

/** Rows listed by name before the rest is folded into a count. */
const MAX_LISTED = 3;

/** Human label for one reason. `t` comes from i18n so both locales share
 * the grouping logic and only the phrases differ. */
export interface BlockedLabels {
	reason(reason: BlockedReason): string;
	group(reason: BlockedReason): string;
	headline(count: number): string;
	listed: string;
	folded(count: number): string;
	othersUnaffected: string;
}

/** Build the display form: name up to three rows, then group the rest by
 * reason. Pure — the panel, the status modal and the notice all call it,
 * so the three can never disagree about what "未同步" means. */
export function summarizeBlocked(
	blocked: readonly BlockedPath[],
	labels: BlockedLabels,
): BlockedSummary {
	const files: BlockedSummary["files"] = [];
	const seen = new Set<string>();
	for (const b of blocked) {
		const key = `${b.path}\u0000${b.reason}`;
		if (seen.has(key)) continue;
		seen.add(key);
		files.push({ ...b, label: labels.reason(b.reason) });
	}
	const count = files.length;
	if (count === 0) {
		return { count: 0, headline: "", detail: "", files: [] };
	}
	const listed = files
		.slice(0, MAX_LISTED)
		.map((f) => `${f.path}（${f.label}）`)
		.join("、");
	const folded =
		count > MAX_LISTED ? labels.folded(count) : "";
	const groups =
		count > MAX_LISTED ? groupText(files, labels) : "";
	return {
		count,
		headline: labels.headline(count),
		detail:
			`${labels.listed}${listed}${folded}${groups}\n` +
			labels.othersUnaffected,
		files,
	};
}

/** "；其中 2 个超过单文件上限、1 个无法读取" — only for the folded form. */
function groupText(
	files: BlockedSummary["files"],
	labels: BlockedLabels,
): string {
	const counts = new Map<BlockedReason, number>();
	for (const f of files) {
		counts.set(f.reason, (counts.get(f.reason) ?? 0) + 1);
	}
	const parts = BLOCKED_REASONS.filter((r) => counts.has(r)).map((r) =>
		labels.group(r).replace("{n}", String(counts.get(r) ?? 0)),
	);
	return parts.length > 0 ? `；其中 ${parts.join("、")}` : "";
}

/** Distinct paths (for "open the first one" style actions). */
export function blockedPaths(blocked: readonly BlockedPath[]): string[] {
	return [...new Set(blocked.map((b) => b.path))];
}
