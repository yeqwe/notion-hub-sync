// Local snapshot: what the vault looks like now, expressed against the
// base (sync-state) entries. Rename hints + prefix remap resolve base
// paths to current paths; mtimes let unchanged files reuse their sha.

import { sha256Hex } from "../sync/hashes";
import {
	basename,
	isSyncablePath,
	parentDir,
	type VaultFile,
	type VaultIO,
} from "../sync/vault-io";
import type { SyncState, SyncEntry } from "../sync/state";
import { childDirOf, normalizeVaultPath } from "../sync/paths";
import type { BlockedPath } from "../sync/blocked";
import type { Scope } from "../sync/scope";
import type { LocalAdded, ParentRef, Side } from "./types";

/** Do two mtimes name the same instant?
 *
 * A base written by an older version (or by the adapter path, which reports
 * fractional milliseconds on Windows) can carry `1792825000490.75` while the
 * vault listing reports `1792825000491`. Plain `===` then never matches, the
 * sha is recomputed from disk on EVERY round, and the file is re-uploaded
 * whenever the remote side was not evaluated. Compare rounded values so a
 * value stored either way keeps working; rounding at the source
 * (`sync/obsidian-vault.ts`, `config/config-io.ts`) keeps NEW writes exact.
 */
export function sameStat(
	base: number | undefined,
	current: number | undefined,
): boolean {
	if (base === undefined || current === undefined) return false;
	return Math.round(base) === Math.round(current);
}

export interface LocalSnapshot {
	/** id → evaluated side (only evaluated ids present). */
	local: Record<string, Side>;
	localAdded: LocalAdded[];
	/** id → current local path after hints (all base ids). */
	pathOf: Map<string, string>;
	/** dir path → base folder id ("root" for vault root). */
	folderIdByPath: Map<string, string>;
	/** claimed paths (base ids + matched renames). */
	claimed: Set<string>;
	/** paths blocked this round (unreadable, case clash, out of scope). */
	blocked: BlockedPath[];
	/** The local listing looked incomplete (a large share of the base
	 * vanished at once). Deletions were suppressed for this round — see the
	 * sanity check in `snapshotLocal`. */
	massDeletion: boolean;
	/** ids whose local file was observed present this round (mtime+size
	 * recorded), so the next round can tell "the user deleted it" from
	 * "the listing did not mention it". */
	seenNow: Map<string, { mtime: number; size: number }>;
	/** What the scan actually did — the caller decides whether a milestone
	 * line is worth printing (an idle round should stay quiet). */
	stats: {
		listedFiles: number;
		listedFolders: number;
		/** sha reused because mtime+size matched the base. */
		reused: number;
		/** files actually read and hashed. */
		hashed: number;
		/** deleted+added pairs recognised as a move. */
		renames: number;
	};
}

/**
 * Paths that differ only by case are ONE file on Windows and on macOS's
 * default filesystem. Two such paths cannot both exist locally, so a
 * remote pair would ping-pong overwriting each other forever.
 *
 * Both are blocked rather than picking a winner: which one is "right" is
 * not knowable from here, and silently dropping either loses content.
 *
 * Comparison happens on the NFC-normalized form. macOS reports filenames
 * as NFD; without normalizing, `café` from the disk and `café` from Notion
 * are different strings and neither this check NOR the engine's own path
 * lookup ever matches.
 */
export function findCaseConflicts(
	paths: readonly string[],
): Map<string, string[]> {
	const byKey = new Map<string, string[]>();
	for (const p of paths) {
		const key = normalizeVaultPath(p).toLowerCase();
		const list = byKey.get(key);
		if (list) list.push(p);
		else byKey.set(key, [p]);
	}
	const out = new Map<string, string[]>();
	for (const list of byKey.values()) {
		if (list.length < 2) continue;
		for (const p of list) {
			out.set(p, list.filter((o) => o !== p));
		}
	}
	return out;
}

/** Apply rename hints in order; folder hints remap path prefixes. */
export function applyRenameHints(
	path: string,
	hints: Array<{ from: string; to: string }>,
): string {
	let p = path;
	for (const h of hints) {
		if (p === h.to || p.startsWith(`${h.to}/`)) continue;
		if (p === h.from) {
			p = h.to;
		} else if (p.startsWith(`${h.from}/`)) {
			p = h.to + p.slice(h.from.length);
		}
	}
	return p;
}

export async function snapshotLocal(
	vault: VaultIO,
	state: SyncState,
	/** throttled callback while hashing files (done = files hashed). */
	onProgress?: (done: number, total: number, path: string) => void,
	/** paths this device syncs at all; absent → everything. */
	scope?: Scope,
	/** per-item detail (which files were hashed); absent → silent. */
	debug?: (msg: string) => void,
): Promise<LocalSnapshot> {
	const hints = state.renameHints ?? [];
	const raw = await vault.list();
	const inScope = (p: string, isDir: boolean): boolean =>
		(!scope || scope.allows(p, isDir)) && isSyncablePath(p);
	const files = raw.files.filter((f) => inScope(f.path, false));
	const folders = raw.folders.filter((f) => inScope(f, true));
	// NFC-normalize every path straight off the disk. macOS hands back NFD,
	// Notion hands back NFC; comparing the two forms makes an unchanged file
	// look deleted (→ the remote page gets trashed) and unnoticed (→ it is
	// pushed again every round). Normalizing here makes both sides agree by
	// construction, and every Map below is keyed on the same form.
	const fileByPath = new Map<string, VaultFile>();
	for (const f of files) {
		const p = normalizeVaultPath(f.path);
		fileByPath.set(p, p === f.path ? f : { ...f, path: p });
	}
	const folderSet = new Set(
		folders.map((f) => normalizeVaultPath(f)).filter((f) => f !== ""),
	);

	// Case-clashing local twins: both blocked, neither pushed nor deleted.
	const blocked: BlockedPath[] = [];
	const caseConflicts = findCaseConflicts([
		...fileByPath.keys(),
		...folderSet,
	]);
	for (const [path, twins] of caseConflicts) {
		blocked.push({
			path,
			reason: "caseConflict",
			detail: twins.join(", "),
		});
	}
	const clashing = new Set(caseConflicts.keys());
	if (clashing.size > 0) {
		debug?.(`local: ${clashing.size} path(s) blocked by case conflict`);
	}
	debug?.(
		`local: ${fileByPath.size} file(s), ${folderSet.size} folder(s) listed ` +
			`(rename hints=${hints.length})`,
	);

	// current local path for every base id (rename hints applied)
	const pathOf = new Map<string, string>();
	const folderIdByPath = new Map<string, string>([["", "root"]]);
	for (const [id, e] of Object.entries(state.entries)) {
		const p = normalizeVaultPath(applyRenameHints(e.path, hints));
		pathOf.set(id, p);
		if (e.kind === "folder") folderIdByPath.set(p, id);
	}

	const parentRefFor = (dir: string): ParentRef => {
		if (dir === "") return { id: "root" };
		const folderId = folderIdByPath.get(dir);
		return folderId ? { id: folderId } : { newLocal: dir };
	};

	// A directory that only exists because a NOTE holds child pages
	// (`a/b.md` → `a/b/`) is not a vault folder of its own: it has no
	// Notion page and must never become one. Children there are parented
	// by the note. Mirrors the applier's `parentChildDir`.
	const shadowByDir = new Map<string, { id: string; kind: SyncEntry["kind"] }>();
	for (const [id, e] of Object.entries(state.entries)) {
		if (e.kind !== "note" && e.kind !== "file") continue;
		const p = pathOf.get(id)!;
		shadowByDir.set(childDirOf(p, e.kind), { id, kind: e.kind });
	}
	const shadowParentOf = (dir: string): ParentRef | null => {
		const s = shadowByDir.get(dir);
		return s ? { id: s.id } : null;
	};
	/** Parent ref for a CHILD sitting in `dir`: the note that owns the
	 * directory when it is a note's child-page dir, else the dir itself. */
	const parentRefForChild = (dir: string): ParentRef =>
		shadowParentOf(dir) ?? parentRefFor(dir);

	const total = fileByPath.size;
	let done = 0;
	let lastEmit = 0;
	const tick = (path: string): void => {
		done++;
		const n = Date.now();
		if (done === 1 || done % 50 === 0 || n - lastEmit > 200) {
			lastEmit = n;
			onProgress?.(done, total, path);
		}
	};

	const local: Record<string, Side> = {};
	const claimed = new Set<string>();
	/** ids that look deleted locally but must not be believed. */
	const suspect = new Set<string>();
	/** ids whose local file was actually observed present this round. */
	const seenNow = new Map<string, { mtime: number; size: number }>();
	let reused = 0;
	let hashed = 0;
	for (const [id, e] of Object.entries(state.entries)) {
		const p = pathOf.get(id)!;
		// Out of scope / case-clashing: do NOT evaluate. An absent evaluation
		// means "unchanged" to the planner, which is exactly right — this
		// device neither pushes, pulls, nor deletes the path this round.
		if ((scope && !scope.allows(p, e.kind === "folder")) || clashing.has(p)) {
			continue;
		}
		if (e.kind === "folder") {
			if (folderSet.has(p)) {
				local[id] = {
					deleted: false,
					parent: parentRefFor(parentDir(p)),
					name: basename(p),
					sha: null,
				};
				claimed.add(p);
				// folders carry no content but still need evidence for the
				// deletion check (a missing directory is a listing problem too)
				e.lastSeenAt = Date.now();
			} else if (await vault.exists(p)) {
				// Same as files: the listing can miss a directory that exists.
				debug?.(`local ${p}: folder missing from the listing but on disk — not a deletion`);
				suspect.add(id);
			} else {
				local[id] = { deleted: true };
				suspect.add(id);
			}
			continue;
		}
		const f = fileByPath.get(p);
		if (!f) {
			// The listing did not mention this path. Before believing that the
			// user deleted it, ask the filesystem directly: `list()` comes from
			// the vault index, which on mobile is populated asynchronously and
			// can miss a file that is right there on disk. Believing the index
			// trashed the page in Notion — the only remaining copy.
			if (await vault.exists(p)) {
				debug?.(
					`local ${p}: missing from the listing but present on disk — not a deletion`,
				);
				suspect.add(id);
				continue; // leave unevaluated: reads as "unchanged" to the planner
			}
			local[id] = { deleted: true };
			suspect.add(id);
			continue;
		}
		claimed.add(p);
		seenNow.set(id, { mtime: f.mtime ?? 0, size: f.size });
		// A file the scan just saw IS evidence for the next round's deletion
		// check. Stamp it here rather than only in the round-end bookkeeping:
		// an entry created by this very round (pushNew) would otherwise carry
		// no evidence until a second round ran, and its first legitimate
		// deletion would be refused.
		e.lastSeenMtime = Math.round(f.mtime ?? 0);
		e.lastSeenSize = f.size;
		e.lastSeenAt = Date.now();
		const baseSha = e.srcSha ?? e.localHash ?? e.fileSha ?? null;
		const reuse =
			sameStat(e.localMtime, f.mtime) &&
			e.localSize === f.size &&
			baseSha !== null;
		if (reuse) {
			reused++;
			// Correct a base written by an older version (a fractional mtime
			// from the adapter). `sameStat` already treats it as unchanged, so
			// this is not a behaviour change — it stops the record from staying
			// non-integral forever.
			e.localMtime = Math.round(f.mtime ?? 0);
			e.localSize = f.size;
		} else {
			hashed++;
			debug?.(`hash ${p} (mtime/size changed or no base sha)`);
		}
		const sha = reuse
			? baseSha
			: await sha256Hex(
					new Uint8Array(await vault.readBinary(f.path)),
				).then((s) => {
					tick(f.path);
					return s;
				});
		local[id] = {
			deleted: false,
			parent: parentRefForChild(parentDir(p)),
			name: basename(p),
			sha,
		};
	}
	// unclaimed files/folders → LocalAdded
	// Every base path, in one set: the folder loop below used to rebuild
	// `[...pathOf.values()]` and search it once per unclaimed directory,
	// which is O(folders × entries) — a 2000-file vault spent more time in
	// that allocation than in hashing.
	const basePaths = new Set(pathOf.values());
	const localAdded: LocalAdded[] = [];
	for (const dir of folderSet) {
		if (claimed.has(dir) || folderIdByPath.has(dir)) continue;
		if (clashing.has(dir)) continue;
		// don't claim if some base folder maps to it
		if (basePaths.has(dir)) continue;
		// a note's child-page directory has no page of its own
		if (shadowByDir.has(dir)) continue;
		localAdded.push({
			path: dir,
			kind: "folder",
			parent: parentRefForChild(parentDir(dir)),
			name: basename(dir),
			sha: null,
		});
		claimed.add(dir);
	}
	for (const f of fileByPath.values()) {
		if (claimed.has(f.path)) continue;
		if (clashing.has(f.path)) continue;
		const dir = parentDir(f.path);
		localAdded.push({
			path: f.path,
			kind: f.path.toLowerCase().endsWith(".md") ? "note" : "file",
			// a file sitting in a note's child-page directory is parented
			// by the NOTE page, not by a folder that doesn't exist remotely
			parent: parentRefForChild(dir),
			name: basename(f.path),
			sha: await sha256Hex(
				new Uint8Array(await vault.readBinary(f.path)),
			).then((s) => {
				tick(f.path);
				return s;
			}),
		});
	}

	// fallback rename detection: deleted base note/file with exactly one
	// same-kind same-sha added → it's a move, not delete+add
	let renameDetected = 0;
	const deletedIds = Object.entries(state.entries)
		.filter(
			([id, e]) =>
				e.kind !== "folder" && local[id]?.deleted === true,
		)
		.map(([id]) => id);
	for (const id of deletedIds) {
		const e = state.entries[id]!;
		const baseSha = e.srcSha ?? e.localHash ?? e.fileSha;
		const matches = localAdded.filter(
			(a) => a.kind === e.kind && a.sha === baseSha,
		);
		if (matches.length === 1) {
			const a = matches[0]!;
			local[id] = {
				deleted: false,
				parent: a.parent,
				name: a.name,
				sha: a.sha,
			};
			localAdded.splice(localAdded.indexOf(a), 1);
			claimed.add(a.path);
			pathOf.set(id, a.path);
			renameDetected++;
			debug?.(`rename detected by sha: ${e.path} -> ${a.path}`);
		}
	}

	debug?.(
		`local snapshot: ${reused} sha reused (mtime+size match), ${hashed} hashed, ` +
			`${renameDetected} rename(s) detected, ${localAdded.length} local-only item(s)`,
	);

	// ---- mass-deletion sanity check ----
	// A vault listing that suddenly loses a large share of the base is far
	// more likely to be a half-loaded index (mobile: the vault is still
	// opening, a folder failed to enumerate) than a user deleting half their
	// notes. Believing it would trash those pages in Notion — the only copy
	// left, since the local files are supposedly gone too. Refuse to plan
	// deletions this round instead: nothing is lost, and the next round (with
	// a complete listing) decides normally.
	//
	// Threshold is deliberately high: deleting 10 notes out of 12 in one round
	// is legitimate, deleting 45% of a 100-file vault between two rounds is
	// not something people do by accident in Obsidian.
	//
	// A whole subtree disappearing is the legitimate case and must still work
	// (delete `Big/` and its five empty children are all gone at once): only
	// count entries whose PARENT is still there. If the parent is gone too,
	// this is one directory operation, not a mass deletion.
	const gone = new Set(
		Object.entries(local)
			.filter(([, s]) => s.deleted === true)
			.map(([id]) => id),
	);
	/** Paths whose base entry is gone this round (directories included, so a
	 * deleted subtree can be recognised from its children's paths). */
	const gonePaths = new Set(
		[...gone].map((id) => state.entries[id]?.path ?? "").filter(Boolean),
	);
	const isUnderGone = (path: string): boolean => {
		let dir = parentDir(path);
		while (dir !== "") {
			// The directory itself was deleted in this same round → this entry
			// went with it. That is one user action, not a mass deletion.
			const fid = folderIdByPath.get(dir);
			if (fid && fid !== "root" && gone.has(fid)) return true;
			// The directory no longer exists on disk either, which is the same
			// situation when the parent had no base entry of its own.
			if (!folderSet.has(dir) && gonePaths.has(dir)) return true;
			dir = parentDir(dir);
		}
		return false;
	};
	const orphans = [...gone].filter(
		(id) => !isUnderGone(state.entries[id]?.path ?? ""),
	);
	const evaluated = Object.keys(local).length;
	const MASS_DELETE_FRACTION = 0.4;
	const MASS_DELETE_MIN = 5;
	let massDeletion = false;
	if (
		orphans.length >= MASS_DELETE_MIN &&
		evaluated > 0 &&
		orphans.length / evaluated >= MASS_DELETE_FRACTION
	) {
		massDeletion = true;
		debug?.(
			`local: ${orphans.length}/${evaluated} unrelated entries look deleted — treating the listing as incomplete, deletions suppressed this round`,
		);
		for (const id of suspect) delete local[id];
	}

	return {
		local,
		localAdded,
		pathOf,
		folderIdByPath,
		claimed,
		blocked,
		massDeletion,
		seenNow,
		stats: {
			listedFiles: fileByPath.size,
			listedFolders: folderSet.size,
			reused,
			hashed,
			renames: renameDetected,
		},
	};
}
