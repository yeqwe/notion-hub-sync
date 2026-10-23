// Change journal: one 🧾 page under the sync root; each sync round that
// changed the remote tree prepends a JSON paragraph listing op+id+sha.
// Other devices read top-down until a block id in journalSeen; a gap (none
// of the seen ids found in the newest 5 pages) forces a full audit.

import type { NotionClient } from "../notion/client";
import type { SyncDeps } from "../sync/deps";
import type { SyncState } from "../sync/state";
import { ensureReservedPage } from "../sync/reserved";

export const JOURNAL_TITLE = "🧾 同步日志 (notion-hub-sync)";
export const JOURNAL_ICON = "🧾";

const SEEN_CAP = 50;
const READ_PAGES = 5;
const PRUNE_AGE_MS = 30 * 86_400_000;
const PRUNE_MAX = 20;
const SEGMENT_MAX = 1900;
const OPS_BYTES_MAX = 50_000;

export type JournalOpType = "c" | "m" | "n" | "t";

export interface JournalOp {
	o: JournalOpType;
	id: string;
	s?: string;
}

export interface JournalReadResult {
	/** page ids other devices touched this round (undelivered ops). */
	candidateIds: string[];
	/** whether changes remotely happened at all (any non-self blocks). */
	remoteChanged: boolean;
	/** true → some history was missed: force a full audit. */
	gap: boolean;
	/** block ids to persist as seen (merged newest-first, capped). */
	newSeen: string[];
}

interface JournalBlock {
	id: string;
	type: string;
	in_trash?: boolean;
	created_time?: string;
	paragraph?: {
		rich_text?: Array<{ plain_text?: string; text?: { content?: string } }>;
	};
	[key: string]: unknown;
}

function blockText(b: JournalBlock): string {
	const rt = b.paragraph?.rich_text ?? [];
	return rt
		.map((r) => r.plain_text ?? r.text?.content ?? "")
		.join("");
}

interface ParsedBlock {
	v: 1;
	t: string;
	d: string;
	ops: JournalOp[];
}

function parseBlock(text: string): ParsedBlock | null {
	try {
		const o = JSON.parse(text) as ParsedBlock;
		if (o.v === 1 && typeof o.d === "string" && Array.isArray(o.ops)) {
			return o;
		}
	} catch {
		// not a journal line
	}
	return null;
}

export async function ensureJournal(deps: {
	client: NotionClient;
	state: SyncState;
	saveState(): Promise<void>;
}): Promise<string> {
	return ensureReservedPage(
		deps,
		{ title: JOURNAL_TITLE, icon: JOURNAL_ICON },
		deps.state.journalId,
		(id) => {
			deps.state.journalId = id;
		},
	);
}

/**
 * Read journal newest-first until a seen block id or 5 pages.
 * Pure-ish for tests: takes already-known seen ids from state.
 */
export async function readJournal(
	client: NotionClient,
	journalId: string | undefined,
	deviceShort: string,
	seen: string[],
	full: boolean,
): Promise<JournalReadResult> {
	const seenSet = new Set(seen);
	const newSeen: string[] = [];
	const candidateIds = new Set<string>();
	let remoteChanged = false;
	let foundSeen = seen.length === 0; // empty → nothing to find
	let cursor: string | undefined;
	let hasMoreOlder = false;
	if (journalId === undefined) {
		return {
			candidateIds: [],
			remoteChanged: false,
			gap: false,
			newSeen: [],
		};
	}
	for (let page = 0; page < READ_PAGES; page++) {
		const res = await client.request<{
			results?: JournalBlock[];
			next_cursor?: string | null;
			has_more?: boolean;
		}>(
			"GET",
			`/blocks/${journalId}/children?page_size=100` +
				(cursor ? `&start_cursor=${cursor}` : ""),
		);
		let hitSeen = false;
		for (const b of res.results ?? []) {
			if (b.in_trash || b.type !== "paragraph") continue;
			if (seenSet.has(b.id)) {
				hitSeen = true;
				break;
			}
			newSeen.push(b.id);
			const parsed = parseBlock(blockText(b));
			if (!parsed) continue; // unparseable: mark seen, ignore
			if (parsed.d === deviceShort) continue; // our own
			remoteChanged = true;
			for (const op of parsed.ops) candidateIds.add(op.id);
		}
		if (hitSeen) {
			foundSeen = true;
			break;
		}
		cursor = res.next_cursor ?? undefined;
		if (!res.has_more || !cursor) break;
		if (page === READ_PAGES - 1 && res.has_more) hasMoreOlder = true;
	}
	// if we never hit a seen id but older pages exist and we had seen ids → gap
	const gap = !foundSeen && hasMoreOlder && seen.length > 0;
	void full;
	return {
		candidateIds: [...candidateIds],
		remoteChanged,
		gap,
		newSeen: [...newSeen, ...seen].slice(0, SEEN_CAP),
	};
}

/** Prune journal blocks older than 30 days — full audits only, ≤20. */
export async function pruneJournal(
	client: NotionClient,
	journalId: string,
	now: number,
): Promise<void> {
	const res = await client.request<{ results?: JournalBlock[] }>(
		"GET",
		`/blocks/${journalId}/children?page_size=100`,
	);
	const cutoff = now - PRUNE_AGE_MS;
	let deleted = 0;
	for (const b of res.results ?? []) {
		if (deleted >= PRUNE_MAX) break;
		if (b.in_trash || b.type !== "paragraph") continue;
		const t = b.created_time ? Date.parse(b.created_time) : NaN;
		if (Number.isFinite(t) && t < cutoff) {
			await client.request("DELETE", `/blocks/${b.id}`);
			deleted++;
		}
	}
}

/** Append one journal entry; splits text into ≤1900-char segments, and
 * spills into extra blocks when ops JSON exceeds ~50 KB. */
export async function writeJournal(
	deps: {
		client: NotionClient;
		state: SyncState;
		saveState(): Promise<void>;
		/** per-round detail; the caller already logs the milestone itself. */
		debug?: (msg: string) => void;
	},
	ops: JournalOp[],
): Promise<void> {
	if (ops.length === 0) return;
	const journalId = await ensureJournal(deps);
	const byType: Record<string, number> = {};
	for (const op of ops) byType[op.o] = (byType[op.o] ?? 0) + 1;
	deps.debug?.(
		`journal: appending ${ops.length} op(s) ${JSON.stringify(byType)} to ${journalId.slice(0, 8)}`,
	);
	const json = JSON.stringify({
		v: 1,
		t: new Date().toISOString(),
		d: (deps as SyncDeps).deviceId?.slice(0, 8) ?? "local",
		ops,
	});
	// split into ≤1900-char rich_text segments (split at arbitrary offsets —
	// Notion rejoins them into one paragraph text)
	const segments: string[] = [];
	for (let i = 0; i < json.length; i += SEGMENT_MAX) {
		segments.push(json.slice(i, i + SEGMENT_MAX));
	}
	const makeBlock = (segs: string[]) => ({
		type: "paragraph",
		paragraph: {
			rich_text: segs.map((s) => ({ type: "text", text: { content: s } })),
		},
	});
	const children = [makeBlock(segments)];
	// very large entries: split by ops into several blocks instead
	if (json.length > OPS_BYTES_MAX && ops.length > 1) {
		children.length = 0;
		const half = Math.ceil(ops.length / 2);
		for (const chunk of [ops.slice(0, half), ops.slice(half)]) {
			const j = JSON.stringify({
				v: 1,
				t: new Date().toISOString(),
				d: (deps as SyncDeps).deviceId?.slice(0, 8) ?? "local",
				ops: chunk,
			});
			const segs: string[] = [];
			for (let i = 0; i < j.length; i += SEGMENT_MAX) {
				segs.push(j.slice(i, i + SEGMENT_MAX));
			}
			children.push(makeBlock(segs));
		}
	}
	await deps.client.request("PATCH", `/blocks/${journalId}/children`, {
		position: { type: "start" },
		children,
	});
}
