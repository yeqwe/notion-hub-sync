// "Pending changes": what the next round would send, expressed the way
// `git status` does it. This is a READ-ONLY view of the same two inputs the
// engine uses (state.entries = base, the vault listing = local), so it can
// never disagree with what a sync would actually do — and it costs no API
// calls, which is why the panel can refresh it on every keystroke.
//
// Deliberately conservative: a file is listed only when the mismatch is
// provable from size+mtime or a hash. "Maybe changed" is not a change.

import { isSyncablePath } from "./vault-io";
import type { SyncEntry, SyncState } from "./state";
import type { BlockedPath } from "./blocked";
import { inExcludedFolder, type ScopeSettings } from "./scope";

export type ChangeStatus = "new" | "modified" | "renamed" | "deleted";

export interface PendingChange {
	path: string;
	status: ChangeStatus;
	name: string;
}

export interface LocalFileInfo {
	path: string;
	size: number;
	mtime: number;
}

export interface ScanChangesInput {
	state: SyncState;
	files: readonly LocalFileInfo[];
	/** Paths blocked this round (shown separately, never as "pending"). */
	blocked?: readonly BlockedPath[];
	/** Scope settings; out-of-scope paths are not "pending", they are off. */
	scope?: ScopeSettings;
	/** Rename hints recorded since the last round (old → new). */
	renameHints?: ReadonlyArray<{ from: string; to: string }>;
	/** Cap so a broken vault can't freeze the panel. */
	limit?: number;
}

const DEFAULT_LIMIT = 500;

/** Fast path: same size AND same mtime ⇒ not modified, no hashing needed.
 * The reverse is not true (a touch without a write bumps mtime), and that
 * is acceptable here — this is a hint list, and the engine re-hashes.
 *
 * Compared ROUNDED, because that is what the base stores: the engine writes
 * `Math.round(mtime)` (Windows adapters report fractional milliseconds while
 * `TFile.stat` reports integers) and `sameStat` compares the same way. A
 * raw `!==` here marked EVERY file as modified on those platforms — the
 * panel said "changes pending" forever while the engine saw nothing to do. */
function looksModified(entry: SyncEntry, f: LocalFileInfo): boolean {
	if (entry.localMtime === undefined || entry.localSize === undefined) {
		return true;
	}
	return (
		Math.round(entry.localMtime) !== Math.round(f.mtime) ||
		entry.localSize !== f.size
	);
}

export function scanPendingChanges(input: ScanChangesInput): PendingChange[] {
	const { state, files, scope } = input;
	const limit = input.limit ?? DEFAULT_LIMIT;
	const hints = input.renameHints ?? [];
	const renameTo = new Map<string, string>();
	const renameFrom = new Set<string>();
	for (const h of hints) {
		renameTo.set(h.from, h.to);
		renameFrom.add(h.to);
	}
	const blockedPaths = new Set(
		(input.blocked ?? []).map((b) => b.path.toLowerCase()),
	);

	const inScope = (p: string, isDir: boolean): boolean => {
		if (!isSyncablePath(p)) return false;
		if (scope && inExcludedFolder(p, scope.excludedFolders)) return false;
		// A blocked path is not a *pending* change: the engine deliberately
		// skips it, so listing it here would promise work that won't happen.
		if (!isDir && blockedPaths.has(p.toLowerCase())) return false;
		return true;
	};

	const fileByPath = new Map<string, LocalFileInfo>();
	for (const f of files) {
		if (inScope(f.path, false)) fileByPath.set(f.path, f);
	}

	const out: PendingChange[] = [];
	const claimed = new Set<string>();

	// base entries → modified / renamed / deleted
	for (const [, e] of Object.entries(state.entries)) {
		if (e.kind === "folder") continue; // folders carry no content
		if (!inScope(e.path, false) && !inScope(e.path, true)) continue;
		if (blockedPaths.has(e.path.toLowerCase())) continue;
		const hinted = renameTo.get(e.path);
		const current = hinted ?? e.path;
		if (current !== e.path) {
			out.push({ path: current, status: "renamed", name: basename(current) });
			claimed.add(current);
			const f = fileByPath.get(current);
			if (f && looksModified(e, f)) {
				out.push({ path: current, status: "modified", name: basename(current) });
			}
			continue;
		}
		const f = fileByPath.get(e.path);
		if (!f) {
			out.push({ path: e.path, status: "deleted", name: basename(e.path) });
			continue;
		}
		claimed.add(e.path);
		if (looksModified(e, f)) {
			out.push({ path: e.path, status: "modified", name: basename(e.path) });
		}
	}

	// local files nobody claims → new
	for (const f of fileByPath.values()) {
		if (claimed.has(f.path) || renameFrom.has(f.path)) continue;
		out.push({ path: f.path, status: "new", name: basename(f.path) });
	}

	// Sort THEN cap: breaking out of the loop above would keep whatever
	// iteration order the vault listing happened to have and silently drop
	// paths from the middle of the alphabet.
	out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	return out.slice(0, limit);
}

function basename(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.slice(idx + 1);
}

/** Single-letter mark, `git status` style. */
export function statusMark(status: ChangeStatus): string {
	return { new: "U", modified: "M", renamed: "R", deleted: "D" }[status];
}
