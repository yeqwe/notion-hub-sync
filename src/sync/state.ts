export interface SyncEntry {
	path: string;
	kind: "folder" | "note" | "file" | "history";
	notionTitle: string;
	parentId: string;
	localHash?: string;
	srcSha?: string;
	visSha?: string;
	fileSha?: string;
	/** Page that holds this file's version blocks (child of historyRootId). */
	historyPageId?: string;
	/** When this device last wrote a "push" version (ms epoch). */
	lastVersionAt?: number;
	/** Sha256 of the most recently recorded version content. */
	lastVersionSha?: string;
	/** M4: last round this entry's remote content was evaluated. */
	checkedAt?: number;
	/** M4: media block id holding the file content (files only). */
	mediaBlockId?: string;
	/** M4: local mtime/size at last sync — lets the local snapshot reuse sha. */
	localMtime?: number;
	localSize?: number;
	/** Local mtime/size as observed at the END of the last round in which this
	 * entry's local file was actually seen.
	 *
	 * This is what makes "the file is gone" mean "the user deleted it". The
	 * local listing comes from Obsidian's vault index, which on mobile is
	 * filled asynchronously and can miss a file that is right there on disk;
	 * a file can also vanish because a write failed or a restore tool removed
	 * it. RS requires `prevSync == current` before it will propagate a
	 * deletion, and so do we: if the entry's recorded local state disagrees
	 * with the base, the disappearance is unexplained and nothing is deleted
	 * on either side. */
	lastSeenMtime?: number;
	lastSeenSize?: number;
	/** When the local file was last observed present (ms epoch). */
	lastSeenAt?: number;
	/** Shas the base held BEFORE the current one, newest first, limited to
	 * versions that arrived FROM the remote (a pull / conflict copy / restore
	 * overwrote the local file with them).
	 *
	 * This is what tells "the user edited this file" apart from "the file was
	 * rolled back": a local file whose bytes hash to one of these was not
	 * edited, it was replaced by an older copy (iCloud replaying a vault, a
	 * second sync tool, an editor restoring a buffer after the process was
	 * killed). Pushing that would overwrite a NEWER remote version with an
	 * older one — a phone that slept through a day of work erasing it on the
	 * next foreground sync. Only remote-sourced versions are recorded here on
	 * purpose: rolling back past content the user themselves pushed is much
	 * more likely to be a deliberate revert. */
	shaHistory?: string[];
	/** M6: last seen remote last_edited_time — unchanged ⇒ not a candidate. */
	remoteEdited?: string;
	/** M6: versions recorded for this entry (gates retention listing). */
	versionCount?: number;
}

export interface RenameHint {
	from: string;
	to: string;
}

export interface SyncState {
	version: 1;
	rootPageId: string;
	/** Container page for all version history (created lazily). */
	historyRootId?: string;
	/** Change-journal page id (created lazily). */
	journalId?: string;
	/** ⚙️ config container page id (created lazily). */
	configRootId?: string;
	/** Config files base, keyed by path relative to configDir. */
	config?: Record<
		string,
		{
			pageId: string;
			sha: string;
			mediaBlockId?: string;
			localMtime?: number;
			localSize?: number;
		}
	>;
	/** ms epoch of last config-dir scan (mobile throttling). */
	lastConfigScan?: number;
	/** Journal block ids already consumed (newest first, capped at 50). */
	journalSeen?: string[];
	/** Search high-water mark: max last_edited_time seen (ISO). */
	searchCursor?: string;
	/** ms epoch of last full structural audit. */
	lastFullAudit?: number;
	/** Local rename hints captured between rounds. */
	renameHints?: RenameHint[];
	/** ms epoch of the last successful round (gates auto-sync). */
	lastSyncAt?: number;
	/** ms epoch the last round ENDED, success or failure. Read by the
	 * interval/foreground gates: `lastSyncAt` only advances on a completed
	 * round, so a device stuck on a failing round would otherwise retry on
	 * every minute tick. Kept separate so the UI can still say when the last
	 * round actually *succeeded*. */
	lastRoundAt?: number;
	/** Page ids known to be outside our tree — skip parent-chain probes
	 * (FIFO, capped at 2000). */
	outsideTree?: string[];
	/** Last round's outcome (status modal / ribbon tooltip). */
	lastReport?: {
		created: number;
		updated: number;
		skipped: number;
		failed: number;
		failures: string[];
		warnings: string[];
		conflictCopies: string[];
		/** Per-path block reasons (out of scope paths are not listed here). */
		blocked?: import("./blocked").BlockedPath[];
	};
	entries: Record<string, SyncEntry>;
}

export function emptyState(rootPageId: string): SyncState {
	return { version: 1, rootPageId, entries: {} };
}

/** How many superseded shas one entry remembers. Eight versions is far more
 * than any rollback a stale client produces, and costs a few hundred bytes
 * per entry. */
export const SHA_HISTORY_MAX = 8;

/** The sha the base currently holds (what the last round left both sides
 * agreeing on), or null when this entry has never carried content. */
export function baseShaOf(e: SyncEntry): string | null {
	return e.srcSha ?? e.localHash ?? e.fileSha ?? null;
}

/**
 * Move the entry's base sha to `next`.
 *
 * `history` must be true only when the LOCAL file was just overwritten with
 * remote content: that is the only case where the outgoing sha becomes a
 * version the local disk may later "roll back to" without the user editing
 * anything. A push replaces the remote with local content, so its previous
 * sha is deliberately not remembered (see `SyncEntry.shaHistory`).
 */
export function recordBaseSha(
	e: SyncEntry,
	next: string | null,
	opts?: { history?: boolean },
): void {
	const prev = baseShaOf(e);
	if (opts?.history && prev !== null && next !== null && prev !== next) {
		const kept = (e.shaHistory ?? []).filter(
			(s) => s !== prev && s !== next,
		);
		kept.unshift(prev);
		e.shaHistory = kept.slice(0, SHA_HISTORY_MAX);
	}
	e.localHash = next ?? undefined;
	e.srcSha = next ?? undefined;
}

export function entryByPath(
	state: SyncState,
	path: string,
): { pageId: string; entry: SyncEntry } | null {
	for (const [pageId, entry] of Object.entries(state.entries)) {
		if (entry.path === path) {
			return { pageId, entry };
		}
	}
	return null;
}

export function pathForPageId(
	state: SyncState,
	pageId: string,
): string | null {
	const hex = pageId.replace(/-/g, "").toLowerCase();
	return state.entries[hex]?.path ?? null;
}
