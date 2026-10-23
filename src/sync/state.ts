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
	};
	entries: Record<string, SyncEntry>;
}

export function emptyState(rootPageId: string): SyncState {
	return { version: 1, rootPageId, entries: {} };
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
