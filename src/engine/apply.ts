// Applier: executes planner actions. Order is already safe (folders first,
// trash last). Each action: remote op → local op → base entry update.
// Local files are re-hashed before overwrite/trash — if the user edited
// since the snapshot, the action is skipped and the next round handles it.

import { sha256Hex } from "../sync/hashes";
import { NotionApiError } from "../notion/client";
import {
	basename,
	parentDir,
	writeTextVerified,
	writeVerified,
	type VaultFile,
} from "../sync/vault-io";
import { collisionFreePath, conflictPath, childDirOf } from "../sync/paths";
import { newReport, type SyncDeps, type SyncReport } from "../sync/deps";
import { recordBaseSha, type SyncEntry } from "../sync/state";
import {
	createPage,
	pushNoteContent,
	pushFileContent,
	titleFor,
	makeLinks,
} from "../sync/push";
import { fetchNoteContent, fetchFileContent, RemoteTooLargeError } from "../sync/pull";
import { getPage, hex } from "./remote-audit";
import { safeRecordVersion } from "../sync/history";
import { Semaphore } from "../sync/pool";
import { merge3Text } from "./merge3";
import type { BaseStore } from "./base-store";
import type { JournalOp } from "./journal";
import type { LocalSnapshot } from "./local";
import type { RemoteSnapshot } from "./remote";
import type { Action, ParentRef } from "./types";

export interface ApplyCtx {
	deps: SyncDeps;
	report: SyncReport;
	localSnap: LocalSnapshot;
	remoteSnap: RemoteSnapshot;
	baseStore: BaseStore;
	journalOps: JournalOp[];
	/** dir path → page id (as promise: parallel apply may ask twice). */
	newRemoteFolders: Map<string, Promise<string>>;
	/** old hex → new hex for recreateRemote — parent refs that still point
	 * at the trashed page id resolve to the replacement. */
	recreated: Map<string, string>;
	/** ms epoch of the last mid-apply state checkpoint. */
	lastCheckpoint?: number;
	/** entry count at that checkpoint (see {@link checkpoint}). */
	lastCheckpointCount?: number;
}

/** Persist state mid-apply so an interrupted round doesn't lose track of
 * pages already created in Notion.
 *
 * A checkpoint is a FULL serialisation+write of the state (megabytes on a
 * large vault), and the previous "every 3 s, unconditionally" rule made a
 * 30-minute first sync write it ~600 times. Two clocks instead:
 *
 *  • 3 s when the number of entries changed — a newly created page is the
 *    only thing that can be ORPHANED by an interruption (it exists in Notion
 *    with no record here), so those are persisted promptly;
 *  • 30 s otherwise (content/base updates), where the worst case after a
 *    crash is that a few files are re-evaluated — no orphan, no data loss. */
const CHECKPOINT_MS = 3000;
const CHECKPOINT_SLOW_MS = 30_000;

async function checkpoint(ctx: ApplyCtx, force = false): Promise<void> {
	const now = ctx.deps.now?.() ?? Date.now();
	const since = now - (ctx.lastCheckpoint ?? 0);
	// cheap gate first: the entry count is only computed when a write could
	// actually happen (this runs once per action, so it must stay O(1))
	if (!force && since < CHECKPOINT_MS) return;
	const count = Object.keys(ctx.deps.state.entries).length;
	const structural = count !== ctx.lastCheckpointCount;
	if (!force && !structural && since < CHECKPOINT_SLOW_MS) return;
	ctx.lastCheckpoint = now;
	ctx.lastCheckpointCount = count;
	try {
		await ctx.deps.saveState();
	} catch (err) {
		ctx.report.warnings.push(`state checkpoint failed: ${String(err)}`);
	}
}

const dec = new TextDecoder();

// pushNoteContent/pushFileContent count report.updated themselves (they are
// also used by the bootstrap path); inside the engine the action owns the
// count, so give them a scratch report and merge back everything except
// created/updated.
function scratchReport(): SyncReport {
	return newReport();
}

function mergeScratch(dst: SyncReport, src: SyncReport): void {
	dst.failed += src.failed;
	dst.failures.push(...src.failures);
	dst.warnings.push(...src.warnings);
	dst.blocked.push(...src.blocked);
	dst.conflictCopies.push(...src.conflictCopies);
}

function entryOf(ctx: ApplyCtx, id: string): SyncEntry | undefined {
	return ctx.deps.state.entries[id];
}

/** Was this entry's REMOTE content compared this round?
 *
 * The planner treats an id missing from `remote` as "unchanged", which is
 * right for deciding what to DO — the remote snapshot only spends requests
 * on pages that might have changed. It is NOT safe as a licence to overwrite:
 * an unevaluated page may well be newer. A push is irreversible for the other
 * device, so it needs an observation, not an assumption. */
function remoteEvaluated(ctx: ApplyCtx, id: string): boolean {
	return ctx.remoteSnap.remote[id] !== undefined;
}

/** Did the remote page change since this round's snapshot?
 *
 * Used as the last gate before a push. `pushContent` is planned from
 * "local changed, remote unchanged" — but in an INCREMENTAL round the remote
 * side of most entries was never looked at (only journal candidates, search
 * hits and the round-robin sample are evaluated). An unevaluated entry reads
 * as "unchanged", so a page edited on another device a minute ago would be
 * overwritten with this device's version without anyone comparing them.
 *
 * One GET /pages per push is a fair price for not losing that edit: a push is
 * irreversible for the other device, while a deferral just costs a round.
 * `last_edited_time` is minute-rounded and API writes don't bump it, so it is
 * only trusted in ONE direction: a DIFFERENT value proves the page changed;
 * an equal value proves nothing, and the push proceeds (the sha comparison in
 * the next round still catches the rare same-minute collision). */
async function remoteTouchedSince(
	ctx: ApplyCtx,
	id: string,
): Promise<boolean> {
	const e = entryOf(ctx, id);
	if (!e?.remoteEdited) return false; // nothing recorded to compare against
	try {
		const info = await getPage(ctx.deps.client, id);
		if (info === null || info.inTrash) return false; // gone: pushNew path
		return info.lastEdited !== undefined && info.lastEdited !== e.remoteEdited;
	} catch {
		return false; // unreadable: let the push through, next round verifies
	}
}

function localPathOf(ctx: ApplyCtx, id: string): string {
	return ctx.localSnap.pathOf.get(id) ?? ctx.deps.state.entries[id]!.path;
}

/** local path of a parent ref ("" for root). */
function parentPathOf(ctx: ApplyCtx, parent: ParentRef): string {
	if ("id" in parent) {
		return parent.id === "root"
			? ""
			: (ctx.deps.state.entries[parent.id]?.path ?? "");
	}
	if ("newLocal" in parent) return parent.newLocal;
	return ctx.deps.state.entries[parent.newRemote]?.path ?? "";
}

/** Directory a CHILD of `parent` lands in. A note's own path is a file
 * path (`a/b.md`), so its children go to the sibling folder `a/b/` — a
 * note page that grew child pages in Notion must never produce
 * `a/b.md/child`. Shared with the planner's `dirOf` (same function). */
function parentChildDir(ctx: ApplyCtx, parent: ParentRef): string {
	if ("newLocal" in parent) return parent.newLocal; // already a dir
	const p = parentPathOf(ctx, parent);
	const e =
		"id" in parent
			? parent.id === "root"
				? undefined
				: ctx.deps.state.entries[parent.id]
			: ctx.deps.state.entries[parent.newRemote];
	return childDirOf(p, e?.kind === "note" || e?.kind === "file" ? e.kind : "folder");
}

/** page id of a parent ref, creating remote folders on demand. */
async function parentIdOf(ctx: ApplyCtx, parent: ParentRef): Promise<string> {
	const state = ctx.deps.state;
	if ("id" in parent) {
		if (parent.id === "root") return state.rootPageId;
		const hid = parent.id.replace(/-/g, "").toLowerCase();
		return ctx.recreated.get(hid) ?? parent.id;
	}
	if ("newRemote" in parent) return parent.newRemote;
	// newLocal folder → ensure remote page exists
	return ensureRemoteFolder(ctx, parent.newLocal);
}

function ensureRemoteFolder(ctx: ApplyCtx, dir: string): Promise<string> {
	const cached = ctx.newRemoteFolders.get(dir);
	if (cached) return cached;
	const p = createRemoteFolder(ctx, dir);
	ctx.newRemoteFolders.set(dir, p);
	return p;
}

async function createRemoteFolder(
	ctx: ApplyCtx,
	dir: string,
): Promise<string> {
	const baseId = ctx.localSnap.folderIdByPath.get(dir);
	if (baseId && baseId !== "root") return baseId;
	if (dir === "") return ctx.deps.state.rootPageId;
	const parent = parentDir(dir);
	const parentId =
		parent === ""
			? ctx.deps.state.rootPageId
			: (ctx.localSnap.folderIdByPath.get(parent) &&
						ctx.localSnap.folderIdByPath.get(parent) !== "root"
						? ctx.localSnap.folderIdByPath.get(parent)!
						: null) ??
				(await ensureRemoteFolder(ctx, parent));
	const name = basename(dir);
	const created = await createPage(ctx.deps, parentId, name, "📁");
	const id = created.id;
	ctx.journalOps.push({ o: "n", id: id.replace(/-/g, "").toLowerCase() });
	const hexId = id.replace(/-/g, "").toLowerCase();
	ctx.deps.state.entries[hexId] = {
		path: dir,
		kind: "folder",
		notionTitle: name,
		parentId,
		remoteEdited: created.lastEdited,
		// A folder we just created is on disk now: that is the evidence the
		// next round's deletion check needs (otherwise the first legitimate
		// deletion of this folder would be refused as "unexplained").
		lastSeenAt: ctx.deps.now?.() ?? Date.now(),
	};
	await checkpoint(ctx, true); // created page must never be unknown
	return id;
}

function recordEntry(
	ctx: ApplyCtx,
	id: string,
	path: string,
	kind: SyncEntry["kind"],
	parentId: string,
	extra?: Partial<SyncEntry>,
): SyncEntry {
	const e: SyncEntry = {
		...ctx.deps.state.entries[id],
		path,
		kind,
		notionTitle: titleFor(path, kind),
		parentId,
		...extra,
	};
	ctx.deps.state.entries[id] = e;
	return e;
}

async function stampLocal(ctx: ApplyCtx, e: SyncEntry): Promise<void> {
	const s = await ctx.deps.vault.stat(e.path);
	if (s) {
		e.localMtime = s.mtime;
		e.localSize = s.size;
		// This file was just written by us and is on disk right now: that is
		// the evidence the next round's deletion check needs.
		e.lastSeenMtime = s.mtime;
		e.lastSeenSize = s.size;
		e.lastSeenAt = ctx.deps.now?.() ?? Date.now();
	}
}

/** Re-hash the local file; false means it changed since the snapshot.
 * A folder has no content to compare — and `readBinary` on a directory
 * throws on every platform, which used to make every folder `trashLocal`
 * look stale and get skipped (an empty directory stayed behind after its
 * remote deletion, forever). */
async function localShaCurrent(ctx: ApplyCtx, id: string): Promise<boolean> {
	const side = ctx.localSnap.local[id];
	if (!side || side.deleted) return true;
	const e = entryOf(ctx, id);
	if (!e) return false;
	if (e.kind === "folder") return true;
	try {
		const buf = new Uint8Array(await ctx.deps.vault.readBinary(e.path));
		return (await sha256Hex(buf)) === side.sha;
	} catch {
		return false;
	}
}

function vaultFile(path: string): VaultFile {
	return { path, size: 0 };
}

/** Fetch remote bytes, preferring the per-round snapshot cache. */
async function remoteBytes(
	ctx: ApplyCtx,
	id: string,
	kind?: SyncEntry["kind"],
): Promise<Uint8Array> {
	const hit = ctx.remoteSnap.fetchedBytes.get(id);
	if (hit) return hit;
	const k = kind ?? entryOf(ctx, id)?.kind;
	if (k === "file") {
		return (await fetchFileContent(ctx.deps, id)).bytes;
	}
	return (
		await fetchNoteContent(ctx.deps, id, makeLinks(ctx.deps))
	).bytes;
}

/** last_edited_time seen during remote eval — seeds entry.remoteEdited so
 * the next round's search-hit gate skips pages we just learned/pulled. */
function addedLastEdited(ctx: ApplyCtx, id: string): string | undefined {
	return (
		ctx.remoteSnap.fetchedMeta.get(id)?.lastEdited ??
		ctx.remoteSnap.remoteAdded.find((a) => a.id === id)?.lastEdited
	);
}

function freePath(ctx: ApplyCtx, path: string): string {
	const used = new Set(
		Object.values(ctx.deps.state.entries).map((e) =>
			e.path.toLowerCase(),
		),
	);
	return collisionFreePath(parentDir(path), basename(path), used);
}

/** Same idea as {@link freePath}, but the DISK gets the last word.
 *
 * `freePath` only knows the paths the state remembers. The vault also holds
 * things the state does not: a note the user just made, a file another
 * device restored, leftovers from an interrupted round. Writing or renaming
 * onto one of those either overwrites it (data loss) or throws on every
 * round (the action can never land, so the two sides never converge).
 *
 * `pullNew` already guards its target; the three actions that can move or
 * materialise a file — `moveLocal`, `restoreLocal`, `createLocalFolder` —
 * used to write blind. This is their guard. */
async function freeDiskPath(ctx: ApplyCtx, path: string): Promise<string> {
	const used = new Set(
		Object.values(ctx.deps.state.entries).map((e) =>
			e.path.toLowerCase(),
		),
	);
	// Every iteration adds its candidate to `used`, so this walks
	// `name`, `name (2)`, `name (3)`… and always terminates.
	for (;;) {
		const candidate = collisionFreePath(
			parentDir(path),
			basename(path),
			used,
		);
		if (!(await ctx.deps.vault.exists(candidate))) return candidate;
	}
}

async function pushNew(
	ctx: ApplyCtx,
	path: string,
	kind: SyncEntry["kind"],
	parent: ParentRef,
): Promise<string> {
	const parentId = await parentIdOf(ctx, parent);
	const icon = kind === "file" ? "📎" : kind === "folder" ? "📁" : undefined;
	const created = await createPage(
		ctx.deps,
		parentId,
		titleFor(path, kind),
		icon,
	);
	const rawId = created.id;
	const id = rawId.replace(/-/g, "").toLowerCase();
	recordEntry(ctx, id, path, kind, parentId, {
		remoteEdited: created.lastEdited,
	});
	ctx.journalOps.push({ o: "n", id });
	await checkpoint(ctx, true); // created page must never be unknown
	const noHistory = { recordHistory: false }; // initial upload = the version
	const sr = scratchReport();
	if (kind === "note") {
		await pushNoteContent(
			ctx.deps,
			id,
			vaultFile(path),
			makeLinks(ctx.deps),
			sr,
			noHistory,
		);
		const buf = new Uint8Array(await ctx.deps.vault.readBinary(path));
		await ctx.baseStore.putIfFits(id, buf);
	} else if (kind === "file") {
		// hex id, not rawId: state.entries is keyed by hex32 and
		// pushFileContent stamps fileSha/mediaBlockId through it —
		// a dashed id would miss the entry silently.
		await pushFileContent(
			ctx.deps,
			id,
			vaultFile(path),
			sr,
			noHistory,
		);
	}
	mergeScratch(ctx.report, sr);
	await stampLocal(ctx, ctx.deps.state.entries[id]!);
	return id;
}

async function writeRemoteContent(
	ctx: ApplyCtx,
	id: string,
): Promise<SyncReport> {
	const e = entryOf(ctx, id)!;
	const rawId = id; // ids are hex32 in state; api accepts them
	const sr = scratchReport();
	if (e.kind === "note") {
		await pushNoteContent(
			ctx.deps,
			rawId,
			vaultFile(e.path),
			makeLinks(ctx.deps),
			sr,
		);
		const buf = new Uint8Array(await ctx.deps.vault.readBinary(e.path));
		await ctx.baseStore.putIfFits(id, buf);
	} else {
		await pushFileContent(ctx.deps, rawId, vaultFile(e.path), sr);
	}
	mergeScratch(ctx.report, sr);
	await stampLocal(ctx, e);
	return sr;
}

/** Display path for an action, resolved BEFORE applyOne mutates entries. */
function actionPath(ctx: ApplyCtx, action: Action): string {
	if ("localPath" in action) return action.localPath;
	if (
		action.type === "createLocalFolder" ||
		action.type === "pullNew" ||
		action.type === "moveRemote" ||
		action.type === "moveLocal"
	) {
		const dir = parentPathOf(ctx, action.parent);
		return `${dir ? `${dir}/` : ""}${action.name}`;
	}
	return ctx.deps.state.entries[action.id]?.path ?? action.id;
}

/** Group index in execution order. Pool groups run with a semaphore (3) +
 * per-key ordering; sequential groups keep plan order. */
function actionGroup(
	ctx: ApplyCtx,
	a: Action,
): { g: number; pool: boolean } {
	if (
		a.type === "recreateRemote" &&
		ctx.deps.state.entries[a.id]?.kind === "folder"
	) {
		// folder recreates run first (plan order: parents before
		// children) so every later parent lookup hits the new id
		return { g: -1, pool: false };
	}
	switch (a.type) {
		case "createRemoteFolder":
		case "createLocalFolder":
			return { g: 0, pool: false };
		case "moveRemote":
		case "moveLocal":
			return { g: 1, pool: false };
		case "link":
			return { g: 2, pool: false };
		case "pushNew":
		case "pullNew":
		case "localConflictCopy":
		case "conflictCopy":
		case "recreateRemote":
		case "restoreLocal":
			return { g: 3, pool: true };
		case "pushContent":
		case "pullContent":
		case "merge":
			return { g: 4, pool: true };
		case "trashRemote":
			// Pooled *within one depth level* — see the depth batching in
			// applyActions. Trashing a page archives its whole subtree, so a
			// child request queued in the same batch gets 400 "archived
			// ancestor" and its base entry can never be dropped: the failure
			// repeats on every following round. Depth batching keeps the
			// overlap while preserving children-first.
			return { g: 5, pool: true };
		case "trashLocal":
			// Files are pooled. A DIRECTORY must wait until its children are
			// gone (renaming a non-empty dir fails), so folders keep running
			// serially afterwards — plan order is depth-descending, so every
			// child (pooled file or inner folder) finishes before its folder.
			return ctx.deps.state.entries[a.id]?.kind === "folder"
				? { g: 7, pool: false }
				: { g: 6, pool: true };
		default:
			return { g: 8, pool: false }; // forget
	}
}

/** Keys that must not overlap: the entry id plus every local path the
 * action touches. Actions sharing a key run in plan order. */
function actionKeys(ctx: ApplyCtx, action: Action): string[] {
	const keys: string[] = [];
	if ("id" in action) keys.push(`id:${action.id}`);
	keys.push(`path:${actionPath(ctx, action).toLowerCase()}`);
	if (action.type === "moveLocal" || action.type === "moveRemote") {
		keys.push(`path:${localPathOf(ctx, action.id).toLowerCase()}`);
	}
	return keys;
}

export async function applyActions(
	actions: Action[],
	ctx: ApplyCtx,
): Promise<void> {
	const total = actions.filter(
		(a) => a.type !== "link" && a.type !== "forget",
	).length;
	let done = 0;
	ctx.lastCheckpoint = ctx.deps.now?.() ?? Date.now();
	ctx.deps.debug?.(`apply: ${actions.length} action(s), ${total} countable`);
	const exec = async (action: Action): Promise<void> => {
		const countable = action.type !== "link" && action.type !== "forget";
		// resolve before applyOne — trash/move actions mutate entries
		const path = actionPath(ctx, action);
		let ok = true;
		const t0 = Date.now();
		try {
			await applyOne(action, ctx);
		} catch (err) {
			ok = false;
			const msg = err instanceof Error ? err.message : String(err);
			// A remote file above the limit is a policy decision, not a
			// failure: it must land in `blocked` (shown to the user with a
			// reason) rather than inflate the failure count every round.
			if (err instanceof RemoteTooLargeError) {
				ctx.report.blocked.push({
					path,
					reason: "remoteOversized",
					detail: msg,
				});
				if (countable) {
					ctx.deps.event?.({ t: "actionFailed", action: action.type, path, error: msg });
				}
				done++;
				return;
			}
			if (countable) {
				ctx.deps.event?.({
					t: "actionFailed",
					action: action.type,
					path,
					error: msg,
				});
			}
			// A rejected token is not a per-file failure: every remaining
			// action will hit the same wall. Flag it so the round can stop
			// and the host can pause instead of reporting "failed: 200".
			if (err instanceof NotionApiError && (err.status === 401 || err.status === 403)) {
				ctx.report.authFailed = true;
			}
			ctx.report.failed++;
			ctx.report.failures.push(`${action.type} ${path}: ${msg}`);
		}
		if (countable) {
			done++;
			ctx.deps.debug?.(
				`apply ${done}/${total} ${action.type} ${path} (${Date.now() - t0}ms)`,
			);
			ctx.deps.event?.({
				t: "action",
				action: action.type,
				path,
				done,
				total,
				ok,
			});
			ctx.deps.progress?.(done, total, path);
		}
		await checkpoint(ctx);
	};

	// bucket actions into groups (order within a group = plan order)
	const groups = new Map<number, { pool: boolean; list: Action[] }>();
	for (const a of actions) {
		const { g, pool } = actionGroup(ctx, a);
		const bucket = groups.get(g) ?? { pool, list: [] };
		bucket.list.push(a);
		groups.set(g, bucket);
	}

	const sem = new Semaphore(3);
	// per-key chain: actions sharing an id/path run in plan order
	const keyChain = new Map<string, Promise<unknown>>();

	for (const g of [...groups.keys()].sort((a, b) => a - b)) {
		const bucket = groups.get(g)!;
		ctx.deps.debug?.(
			`apply group ${g}: ${bucket.list.length} action(s), ${bucket.pool ? "pooled" : "serial"}`,
		);
		if (!bucket.pool) {
			for (const a of bucket.list) await exec(a);
			continue;
		}
		// Remote trashes are depth-batched: trashing a page archives its
		// whole subtree, so a child still queued in the same batch gets 400
		// "archived ancestor" and its base entry can never be dropped — the
		// failure repeats every round. Within one depth the actions touch
		// disjoint pages (a parent and a child never share a depth), so the
		// pool still overlaps them; the levels themselves run in sequence,
		// deepest first, matching the plan's ordering.
		const batches = g === 5 ? depthBatches(ctx, bucket.list) : [bucket.list];
		for (const list of batches) {
			const tasks = list.map((a) => {
				const keys = actionKeys(ctx, a);
				const prev = Promise.allSettled(
					keys
						.map((k) => keyChain.get(k))
						.filter((p): p is Promise<unknown> => p !== undefined),
				);
				const task = prev
					.then(() => sem.acquire())
					.then(() => exec(a))
					.finally(() => sem.release());
				for (const k of keys) {
					keyChain.set(
						k,
						task.then(
							() => undefined,
							() => undefined,
						),
					);
				}
				return task;
			});
			await Promise.all(tasks);
		}
	}
}

/** Depth of an action's target in the sync tree — parents first, deeper
 * entries have a longer parent chain. Used only to order remote trashes. */
function depthOfAction(ctx: ApplyCtx, action: Action): number {
	if (!("id" in action)) return 0;
	const state = ctx.deps.state;
	let depth = 0;
	let cur = state.entries[action.id]?.parentId;
	const seen = new Set<string>();
	while (cur && cur !== state.rootPageId && !seen.has(cur)) {
		seen.add(cur);
		depth++;
		cur = state.entries[cur]?.parentId;
	}
	return depth;
}

/** Group remote trashes into depth levels, deepest first. Trashing a page
 * archives its whole subtree, so a child in an earlier batch gets 400
 * "archived ancestor" and its base entry can never be dropped — the
 * failure would repeat on every following round. Within one level the
 * pages are unrelated (a parent and a child never share a depth), so the
 * pool may still run them concurrently. */
function depthBatches(ctx: ApplyCtx, list: Action[]): Action[][] {
	const scored = list.map((a) => ({ a, d: depthOfAction(ctx, a) }));
	scored.sort((x, y) => y.d - x.d);
	const out: Action[][] = [];
	let level: number | null = null;
	for (const { a, d } of scored) {
		if (level !== d) {
			out.push([]);
			level = d;
		}
		out[out.length - 1]!.push(a);
	}
	return out;
}

/** Move every child page of `doomedId` under `survivorId` before the
 * trash takes the whole subtree down, repoint the matching base entries,
 * and journal each move so the other devices re-evaluate those children.
 * Returns the number of moved pages. A listing that says the page is
 * already gone skips the merge (nothing to save); a child page that is
 * already archived is skipped the same way. ANY other failure throws —
 * the caller must not trash a page whose children it failed to move. */
async function mergeChildrenInto(
	ctx: ApplyCtx,
	doomedId: string,
	survivorId: string,
): Promise<number> {
	const deps = ctx.deps;
	const state = deps.state;
	const children: string[] = [];
	try {
		let cursor: string | undefined;
		for (;;) {
			const res = await deps.client.request<{
				results?: Array<{ id: string; type: string }>;
				has_more?: boolean;
				next_cursor?: string | null;
			}>(
				"GET",
				`/blocks/${doomedId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
			);
			for (const b of res.results ?? []) {
				if (b.type === "child_page") children.push(hex(b.id));
			}
			if (!res.has_more || !res.next_cursor) break;
			cursor = res.next_cursor;
		}
	} catch (err) {
		if (isAlreadyGone(err)) return 0;
		throw err;
	}
	let moved = 0;
	for (const childHex of children) {
		try {
			await deps.client.request("POST", `/pages/${childHex}/move`, {
				parent: { type: "page_id", page_id: survivorId },
			});
		} catch (err) {
			// The child is already gone — nothing to save for it.
			if (isAlreadyGone(err)) continue;
			throw err;
		}
		const e = state.entries[childHex];
		if (e && hex(e.parentId) === hex(doomedId)) {
			e.parentId = survivorId;
		}
		ctx.journalOps.push({ o: "m", id: childHex });
		moved++;
	}
	return moved;
}

/** The page is already archived, or was swallowed by a trashed ancestor.
 * Both mean "it is not there any more" — the goal of a trash — so the
 * caller can drop its base entry instead of retrying. */
function isAlreadyGone(err: unknown): boolean {
	const status = (err as { status?: number }).status;
	const message = err instanceof Error ? err.message : String(err);
	if (status === 404) return true;
	return /archived|in_trash|not found/i.test(message);
}

/** Parent reference for a vault path, resolved from the LOCAL directory tree
 * (`<path>/../`). Used when an entry is (re-)created and the page parent it
 * used to have can no longer be trusted: a re-create happens because the
 * remote page is gone, and the page it sat under may be gone too. Creating
 * the replacement there would put it in a trashed subtree, which the next
 * round reads as "deleted again" and rebuilds. */
function localParentRef(path: string): ParentRef {
	const dir = parentDir(path);
	if (dir === "") return { id: "root" };
	return { newLocal: dir };
}

/** Take over an existing page as the remote copy of `old`, instead of
 * creating a new one. Used by `recreateRemote` when another device already
 * re-created the item: its page id is unknown to the base here (that is why
 * it showed up as "added"), but it IS the item — adopting it makes both
 * devices converge on one id instead of each deleting the other's page. */
async function adoptRemotePage(
	ctx: ApplyCtx,
	old: SyncEntry,
	pageId: string,
): Promise<string> {
	const id = pageId.replace(/-/g, "").toLowerCase();
	const parentId = await parentIdOf(ctx, localParentRef(old.path));
	recordEntry(ctx, id, old.path, old.kind, parentId, {
		remoteEdited: addedLastEdited(ctx, id),
	});
	// a note's content lives in the page: keep the local bytes as the base so
	// the next merge has a three-way anchor
	if (old.kind === "note") {
		try {
			const buf = new Uint8Array(await ctx.deps.vault.readBinary(old.path));
			await ctx.baseStore.putIfFits(id, buf);
		} catch {
			/* unreadable local copy: leave the base empty */
		}
	}
	await checkpoint(ctx, true);
	return id;
}

async function applyOne(action: Action, ctx: ApplyCtx): Promise<void> {
	const { deps, report } = ctx;
	const state = deps.state;
	deps.debug?.(
		`apply ${action.type} ${"id" in action ? `${action.id} ` : ""}` +
			`${"localPath" in action ? action.localPath : ""}` +
			`${"name" in action ? (action as { name?: string }).name ?? "" : ""}` +
			` ${state.entries["id" in action ? action.id : ""]?.path ?? ""}`,
	);
	switch (action.type) {
		case "link": {
			const added = ctx.remoteSnap.remoteAdded.find(
				(a) => a.id === action.id,
			);
			// The LOCAL shape wins: this action only exists because both
			// sides produced the same path, and a directory path (`a/b`) can
			// never hold a note. Taking the remote guess instead left a
			// `note` entry pointing at a directory.
			const kind = action.kind ?? added?.kind ?? "note";
			const e = state.entries[action.id] ?? {
				path: action.localPath,
				kind,
				notionTitle: titleFor(action.localPath, kind),
				// Resolve the real parent. An empty parentId is never a valid
				// value: the next snapshot would read it as "moved" (and, when
				// the added page can't be found, leave the entry pointing at
				// nothing, which re-creates the item every round). Fall back to
				// the directory the path lives in, which the applier can always
				// resolve.
				parentId: added
					? await parentIdOf(ctx, added.parent)
					: await parentIdOf(ctx, localParentRef(action.localPath)),
			};
			e.kind = kind;
			e.path = action.localPath;
			e.notionTitle = titleFor(action.localPath, kind);
			e.srcSha = e.srcSha ?? added?.sha ?? undefined;
			e.localHash = e.srcSha;
			e.remoteEdited =
				added?.lastEdited ??
				addedLastEdited(ctx, action.id) ??
				e.remoteEdited;
			state.entries[action.id] = e;
			if (e.kind === "note") {
				const buf = new Uint8Array(
					await deps.vault.readBinary(action.localPath),
				);
				await ctx.baseStore.putIfFits(action.id, buf);
			}
			await stampLocal(ctx, e);
			break;
		}
		case "createRemoteFolder": {
			await ensureRemoteFolder(ctx, action.localPath);
			report.created++;
			break;
		}
		case "createLocalFolder": {
			const parent = parentChildDir(ctx, action.parent);
			let path = parent === "" ? action.name : `${parent}/${action.name}`;
			// `mkdirp` is a no-op when something already sits at the path, so a
			// note that happens to carry the folder's name would make this
			// directory silently never exist — and then every child of it fails
			// to write, every round. Put the directory beside the occupant.
			if ((await deps.vault.stat(path)) !== null) {
				const free = await freeDiskPath(ctx, path);
				report.warnings.push(
					`${path}: a file is in the way — folder created as "${free}" instead`,
				);
				path = free;
			}
			await deps.vault.mkdirp(path);
			recordEntry(
				ctx,
				action.id,
				path,
				"folder",
				await parentIdOf(ctx, action.parent),
				{
					remoteEdited: addedLastEdited(ctx, action.id),
					lastSeenAt: deps.now?.() ?? Date.now(),
				},
			);
			report.created++;
			break;
		}
		case "pushNew": {
			await pushNew(ctx, action.localPath, action.kind, action.parent);
			report.created++;
			break;
		}
		case "pullNew": {
			const dir = parentChildDir(ctx, action.parent);
			const wanted = dir === "" ? action.name : `${dir}/${action.name}`;
			const path = (await deps.vault.exists(wanted))
				? freePath(ctx, wanted)
				: wanted;			let bytes: Uint8Array;
			try {
				bytes = await remoteBytes(ctx, action.id, action.kind);
			} catch (err) {
				// A remote file page with no media block (interrupted push,
				// manual page) pulls as empty rather than failing forever.
				if (
					action.kind === "file" &&
					err instanceof Error &&
					/no media block/.test(err.message)
				) {
					bytes = new Uint8Array(0);
				} else {
					throw err;
				}
			}
			const sha = await sha256Hex(bytes);
			await writeVerified(deps.vault, path, bytes, sha);
			const meta = ctx.remoteSnap.fetchedMeta.get(action.id);
			const e = recordEntry(
				ctx,
				action.id,
				path,
				action.kind,
				await parentIdOf(ctx, action.parent),
				{
					localHash: sha,
					srcSha: sha,
					fileSha: action.kind === "file" ? sha : undefined,
					visSha: meta?.visSha,
					mediaBlockId: meta?.mediaBlockId ?? undefined,
					remoteEdited: addedLastEdited(ctx, action.id),
				},
			);
			if (action.kind === "note") {
				await ctx.baseStore.putIfFits(action.id, bytes);
			}
			await stampLocal(ctx, e);
			report.created++;
			break;
		}
		case "pushContent": {
			if (!(await localShaCurrent(ctx, action.id))) {
				report.skipped++;
				deps.debug?.(
					`pushContent ${state.entries[action.id]?.path ?? action.id}: local changed since snapshot — deferred to next round`,
				);
				break;
			}
			// Last gate before the remote is overwritten: was this page
			// evaluated this round? If not, "remote unchanged" is an
			// ASSUMPTION, not an observation — an incremental round only looks
			// at journal candidates, search hits and the round-robin sample, so
			// a page edited on another device (or through the Notion UI, which
			// bumps last_edited_time by a minute at most) can be absent from
			// this round's `remote` map while its content is newer.
			//
			// Overwriting it there is the other half of "the phone undid my
			// work": the desktop's edit is silently replaced. Defer instead —
			// the next round evaluates the page and decides between push,
			// pull and merge with both sides actually known.
			//
			// Only for pages the snapshot did NOT look at: when it did, the
			// sha comparison already happened and "remote unchanged" is an
			// observation. Asking again would cost one wasted GET per pushed
			// note (~30 s of request budget per 100 notes) to re-learn what
			// this round already knows.
			if (
				!remoteEvaluated(ctx, action.id) &&
				(await remoteTouchedSince(ctx, action.id))
			) {
				report.skipped++;
				deps.debug?.(
					`pushContent ${state.entries[action.id]?.path ?? action.id}: remote changed since the snapshot — deferred`,
				);
				break;
			}
			let sr: SyncReport;
			try {
				sr = await writeRemoteContent(ctx, action.id);
			} catch (err) {
				// The page (or an ancestor) is already archived. The content
				// has nowhere to go; the next round's snapshot sees the
				// deletion and the normal deletion path decides what happens
				// to the local copy.
				if (!isAlreadyGone(err)) throw err;
				deps.log?.(
					`pushContent ${state.entries[action.id]?.path ?? action.id}: target gone — skipped`,
				);
				report.skipped++;
				break;
			}
			if (sr.skipped > 0) {
				report.skipped++;
				break;
			}
			const e = entryOf(ctx, action.id)!;
			ctx.journalOps.push({
				o: "c",
				id: action.id,
				s: e.srcSha ?? e.fileSha ?? undefined,
			});
			report.updated++;
			break;
		}
		case "pullContent": {
			if (!(await localShaCurrent(ctx, action.id))) {
				report.skipped++;
				break;
			}
			const e = entryOf(ctx, action.id)!;
			if (await editorDefer(ctx, action.type, e)) break;
			const bytes = await remoteBytes(ctx, action.id);
			if (action.stale) {
				report.warnings.push(
					`${e.path}: local copy was an older version (not an edit) — restored from Notion`,
				);
			}
			try {
				const local = new Uint8Array(
					await deps.vault.readBinary(e.path),
				);
				await safeRecordVersion(
					deps,
					action.id,
					e.path,
					local,
					"pre-pull",
					(msg) => report.warnings.push(msg),
				);
			} catch {
				/* no local copy */
			}
			const sha = await sha256Hex(bytes);
			// The local file is being REPLACED by remote content: remember what
			// the base held so a later rollback of this file is recognisable.
			await writeVerified(deps.vault, e.path, bytes, sha);
			recordBaseSha(e, sha, { history: true });
			e.fileSha = e.kind === "file" ? sha : e.fileSha;
			const meta = ctx.remoteSnap.fetchedMeta.get(action.id);
			if (meta?.visSha) e.visSha = meta.visSha;
			if (meta?.mediaBlockId !== undefined) {
				e.mediaBlockId = meta.mediaBlockId ?? undefined;
			}
			const seenEdited = addedLastEdited(ctx, action.id);
			if (seenEdited) e.remoteEdited = seenEdited;
			if (e.kind === "note") {
				await ctx.baseStore.putIfFits(action.id, bytes);
			}
			await stampLocal(ctx, e);
			report.updated++;
			break;
		}
		case "merge": {
			if (!(await localShaCurrent(ctx, action.id))) {
				report.skipped++;
				break;
			}
			const e = entryOf(ctx, action.id)!;
			if (await editorDefer(ctx, action.type, e)) break;
			const base = await ctx.baseStore.get(action.id);
			const remote = dec.decode(await remoteBytes(ctx, action.id));
			const local = dec.decode(
				new Uint8Array(await deps.vault.readBinary(e.path)),
			);
			const m =
				base === null ? null : merge3Text(base, local, remote);
			if (m && m.clean) {
				const merged = m.text!;
				// Verified: the base is about to record these bytes as
				// "what both sides agree on", so a truncated write would make
				// that record permanently wrong — and the next round would read
				// the truncation as a local edit and push it.
				await writeTextVerified(
					deps.vault,
					e.path,
					merged,
					await sha256Hex(new TextEncoder().encode(merged)),
				);
				await writeRemoteContent(ctx, action.id);
				await ctx.baseStore.put(action.id, m.text!);
				ctx.journalOps.push({
					o: "c",
					id: action.id,
					s: entryOf(ctx, action.id)?.srcSha ?? undefined,
				});
				report.updated++;
			} else {
				await doConflictCopy(ctx, action.id);
			}
			break;
		}
		case "conflictCopy": {
			if (!(await localShaCurrent(ctx, action.id))) {
				report.skipped++;
				break;
			}
			const e = entryOf(ctx, action.id)!;
			if (await editorDefer(ctx, action.type, e)) break;
			await doConflictCopy(ctx, action.id);
			break;
		}
		case "localConflictCopy": {
			const to = conflictPath(
				action.localPath,
				deps.deviceId.slice(0, 8),
				new Date(deps.now?.() ?? Date.now()),
			);
			await deps.vault.rename(action.localPath, to);
			report.conflictCopies.push(to);
			report.updated++;
			break;
		}
		case "moveRemote": {
			const e = entryOf(ctx, action.id)!;
			const parentId = await parentIdOf(ctx, action.parent);
			const title = titleFor(localPathOf(ctx, action.id), e.kind);
			try {
				if (parentId !== e.parentId) {
					await deps.client.request(
						"POST",
						`/pages/${action.id}/move`,
						{ parent: { type: "page_id", page_id: parentId } },
					);
				}
				if (title !== e.notionTitle) {
					await deps.client.request("PATCH", `/pages/${action.id}`, {
						properties: {
							title: { title: [{ text: { content: title } }] },
						},
					});
				}
			} catch (err) {
				// The page (or an ancestor) is already archived — another
				// device, or a trash in an earlier round. Nothing to move, so
				// retire the entry instead of failing this action forever.
				if (!isAlreadyGone(err)) throw err;
				deps.log?.(
					`moveRemote ${state.entries[action.id]?.path ?? action.id}: target gone — dropping entry`,
				);
				delete state.entries[action.id];
				await ctx.baseStore.remove(action.id);
				break;
			}
			remapPaths(state, e.path, localPathOf(ctx, action.id));
			e.parentId = parentId;
			e.notionTitle = title;
			e.path = localPathOf(ctx, action.id);
			ctx.journalOps.push({ o: "m", id: action.id });
			report.updated++;
			break;
		}
		case "moveLocal": {
			const e = entryOf(ctx, action.id)!;
			const dir = parentChildDir(ctx, action.parent);
			let to = `${dir ? `${dir}/` : ""}${action.name}`;
			if (to !== e.path && (await deps.vault.exists(e.path))) {
				// Something else may already occupy the destination — a note
				// the user created, a copy a previous round restored. Renaming
				// onto it overwrites on POSIX and throws on Windows, where the
				// throw repeats on every following round and the two sides
				// never converge. Land beside the occupant instead.
				if (await deps.vault.exists(to)) {
					const free = await freeDiskPath(ctx, to);
					report.warnings.push(
						`${e.path}: "${action.name}" already exists — moved to "${free}" instead`,
					);
					to = free;
				}
				await deps.vault.rename(e.path, to);
			}
			remapPaths(state, e.path, to);
			e.path = to;
			e.notionTitle = titleFor(to, e.kind);
			e.parentId = await parentIdOf(ctx, action.parent);
			report.updated++;
			break;
		}
		case "trashRemote": {
			if (action.mergeInto !== undefined) {
				// Trashing a page archives its whole subtree with it. Rescue
				// the child pages into the surviving duplicate first — a
				// child we fail to move must stop the trash, not die with it.
				const survivor =
					ctx.recreated.get(hex(action.mergeInto)) ??
					action.mergeInto;
				const movedChildren = await mergeChildrenInto(
					ctx,
					action.id,
					survivor,
				);
				if (movedChildren > 0) {
					deps.log?.(
						`trashRemote ${state.entries[action.id]?.path ?? action.id}: moved ${movedChildren} child page(s) to the surviving duplicate first`,
					);
				}
			}
			const base = await ctx.baseStore.get(action.id);
			if (base !== null) {
				await safeRecordVersion(
					deps,
					action.id,
					state.entries[action.id]?.path ?? action.id,
					new TextEncoder().encode(base),
					"pre-delete",
					(msg) => report.warnings.push(msg),
				);
			}
			try {
				await deps.client.request("PATCH", `/pages/${action.id}`, {
					in_trash: true,
				});
			} catch (err) {
				// Another device (or an earlier round of this one) already
				// archived the page — including the case where it sat under a
				// parent that was just trashed. The outcome we wanted is
				// already true, so drop the base entry instead of retrying a
				// doomed request on every following round forever.
				if (!isAlreadyGone(err)) throw err;
				deps.log?.(
					`trashRemote ${state.entries[action.id]?.path ?? action.id}: already gone (${err instanceof Error ? err.message : String(err)})`,
				);
			}
			delete state.entries[action.id];
			await ctx.baseStore.remove(action.id);
			ctx.journalOps.push({ o: "t", id: action.id });
			report.updated++;
			break;
		}
		case "trashLocal": {
			const e = entryOf(ctx, action.id)!;
			if (await localShaCurrent(ctx, action.id)) {
				try {
					const bytes = new Uint8Array(
						await deps.vault.readBinary(e.path),
					);
					await safeRecordVersion(
						deps,
						action.id,
						e.path,
						bytes,
						"pre-delete",
						(msg) => report.warnings.push(msg),
					);
				} catch {
					/* nothing readable */
				}
				if (await deps.vault.exists(e.path)) {
					await deps.vault.trash(e.path);
				}
			}
			delete state.entries[action.id];
			await ctx.baseStore.remove(action.id);
			report.updated++;
			break;
		}
		case "recreateRemote": {
			const old = entryOf(ctx, action.id);
			delete state.entries[action.id];
			await ctx.baseStore.remove(action.id);
			if (old) {
				const newId = action.adopt
					? await adoptRemotePage(ctx, old, action.adopt)
					: await pushNew(
							ctx,
							old.path,
							old.kind,
							localParentRef(old.path),
						);
				ctx.recreated.set(action.id, newId);
				if (old.kind === "folder") {
					ctx.localSnap.folderIdByPath.set(old.path, newId);
				}
			}
			report.created++;
			break;
		}
		case "restoreLocal": {
			const e = entryOf(ctx, action.id)!;
			if (await editorDefer(ctx, action.type, e)) break;
			// land at the remote location (remote may also have moved)
			const rside = ctx.remoteSnap.remote[action.id];
			const rdir =
				rside && rside.deleted === false
					? parentChildDir(ctx, rside.parent)
					: "";
			const path =
				rside && rside.deleted === false
					? rdir === ""
						? rside.name
						: `${rdir}/${rside.name}`
					: e.path;
			// The local copy was deleted; something may have taken the name
			// since. Writing over it would destroy a file this round never
			// looked at, so land beside it instead.
			let target = path;
			if (await deps.vault.exists(target)) {
				target = await freeDiskPath(ctx, target);
				report.warnings.push(
					`${path}: path was occupied — restored as "${target}" instead`,
				);
			}
			const bytes = await remoteBytes(ctx, action.id);
			const sha = await sha256Hex(bytes);
			await writeVerified(deps.vault, target, bytes, sha);
			e.path = target;
			const rparent =
				rside && rside.deleted === false
					? await parentIdOf(ctx, rside.parent)
					: e.parentId;
			e.parentId = rparent;
			recordBaseSha(e, sha, { history: true });
			if (e.kind === "note") {
				await ctx.baseStore.putIfFits(action.id, bytes);
			}
			await stampLocal(ctx, e);
			report.updated++;
			break;
		}
		case "forget": {
			delete state.entries[action.id];
			await ctx.baseStore.remove(action.id);
			break;
		}
	}
}

/** The user is typing in an open editor — don't write under it (the stale
 * buffer would be saved back over our write and read as a user edit). The
 * evaluation's `remoteEdited` stamp must be undone too: it tells the search
 * gate "already evaluated", so a deferred pull would otherwise never be
 * looked at again and the remote edit would be lost for good. */
async function editorDefer(
	ctx: ApplyCtx,
	type: string,
	e: SyncEntry,
): Promise<boolean> {
	if (!(await ctx.deps.vault.editorDirty?.(e.path))) return false;
	ctx.report.skipped++;
	delete e.remoteEdited;
	ctx.deps.debug?.(
		`${type} ${e.path}: open editor has unsaved changes — deferred`,
	);
	return true;
}

async function doConflictCopy(
	ctx: ApplyCtx,
	id: string,
): Promise<void> {
	const { deps, report } = ctx;
	const e = entryOf(ctx, id)!;
	if (await editorDefer(ctx, "conflictCopy", e)) return;
	const local = new Uint8Array(await deps.vault.readBinary(e.path));
	const copy = conflictPath(
		e.path,
		deps.deviceId.slice(0, 8),
		new Date(deps.now?.() ?? Date.now()),
	);
	await deps.vault.writeBinary(copy, local.buffer as ArrayBuffer);
	report.conflictCopies.push(copy);
	await safeRecordVersion(
		deps,
		id,
		e.path,
		local,
		"pre-pull",
		(msg) => report.warnings.push(msg),
	);
	const remote = await remoteBytes(ctx, id);
	const sha = await sha256Hex(remote);
	await writeVerified(deps.vault, e.path, remote, sha);
	// local was overwritten with remote content → remember the outgoing sha
	recordBaseSha(e, sha, { history: true });
	if (e.kind === "note") await ctx.baseStore.putIfFits(id, remote);
	await stampLocal(ctx, e);
	report.updated++;
}

/** After a folder path change, keep descendant entry paths in sync. */
function remapPaths(
	state: { entries: Record<string, SyncEntry> },
	from: string,
	to: string,
): void {
	if (from === to) return;
	for (const e of Object.values(state.entries)) {
		if (e.path === from) {
			e.path = to;
		} else if (e.path.startsWith(`${from}/`)) {
			e.path = to + e.path.slice(from.length);
		}
	}
}
