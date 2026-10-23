// Remote page introspection shared by the remote snapshot (remote.ts) and
// the search-scan audit below. The scan replaces the per-parent children
// walk on full audits: POST /search returns 100 pages per request with
// title/icon/parent/last_edited_time, so a 10k-page tree costs ~100
// requests instead of ~10k. walkTree stays as the fallback in remote.ts.

import type { NotionClient } from "../notion/client";
import type { SyncDeps } from "../sync/deps";
import { sanitizeTitle } from "../sync/paths";
import type { Node } from "../sync/pull";
import { listChildPages } from "../sync/tree";
import { runPool } from "../sync/pool";
import type { SyncEntry, SyncState } from "../sync/state";
import type { Side } from "./types";

/** /search pages fetched per incremental check (stops early at the
 * `since` watermark; this is just the runaway cap). */
export const SEARCH_MAX_PAGES = 5;

/** Audit scans page through the WHOLE workspace: 100 hits per request,
 * so 300 requests ~=30k pages. Still paging at the cap ->walk fallback. */
export const AUDIT_SEARCH_MAX_PAGES = 300;

/** Parents with at least this many children get their children list
 * re-read through GET /blocks/{id}/children. Probed live: /search
 * silently drops children of heavily-populated parents (107-child
 * folder ->99 hits), while lightly-populated ones come back complete.
 * Only a handful of parents ever hit this on a real vault. */
export const HEAVY_PARENT_THRESHOLD = 90;

/** Hit rate below this ->/search is untrustworthy, use the tree walk.
 * A single ascending-sorted sweep returns one page of database rows on
 * a real workspace, which must never be mistaken for "everything was
 * deleted". Only applied once the confirmation cost would be large — * confirming a handful of misses with direct GETs is cheap and correct. */
export const AUDIT_MIN_COVERAGE = 0.5;

/** Below this many missing entries the audit confirms them one by one
 * (handles normal search-index lag); above it, a low hit rate means the
 * scan itself is broken and the tree walk is the only safe answer. */
export const AUDIT_CONFIRM_MAX = 20;

const PARENT_CHAIN_MAX = 3;

/** Per-round cap on stray version pages trashed by an audit. */
const ORPHAN_TRASH_MAX = 100;

export const hex = (id: string): string =>
	id.replace(/-/g, "").toLowerCase();

export interface PageInfo {
	id: string;
	parent: string | null;
	inTrash: boolean;
	title: string;
	icon: string | null;
	lastEdited?: string;
}

export function pageInfo(p: {
	id: string;
	parent?: { type?: string; page_id?: string };
	in_trash?: boolean;
	properties?: {
		title?: {
			title?: Array<{ plain_text?: string; text?: { content?: string } }>;
		};
	};
	icon?: unknown;
	last_edited_time?: string;
}): PageInfo {
	const titles = p.properties?.title?.title ?? [];
	return {
		id: p.id,
		parent: p.parent?.page_id ? hex(p.parent.page_id) : null,
		inTrash: p.in_trash ?? false,
		title: titles.map((t) => t.plain_text ?? t.text?.content ?? "").join(""),
		icon: (p.icon as { emoji?: string } | null | undefined)?.emoji ?? null,
		lastEdited: p.last_edited_time,
	};
}

export async function getPage(
	client: NotionClient,
	id: string,
): Promise<PageInfo | null> {
	try {
		const res = await client.request<Parameters<typeof pageInfo>[0]>(
			"GET",
			`/pages/${id}`,
		);
		return pageInfo(res);
	} catch {
		return null;
	}
}

/** ids of the reserved system pages (journal/history/config roots). */
export function systemRootIds(state: SyncState): Set<string> {
	const s = new Set<string>();
	if (state.journalId) s.add(hex(state.journalId));
	if (state.historyRootId) s.add(hex(state.historyRootId));
	if (state.configRootId) s.add(hex(state.configRootId));
	return s;
}

/** System pages and their flat children (config/history pages) never
 * belong to the vault tree —skip them before spending requests. */
export function isSystemPage(info: PageInfo, sys: Set<string>): boolean {
	// The icon/title check must come first: a second device (or a reset
	// state) creates its own reserved container before it learns the first
	// one, so `sys` alone misses it — and then the whole history/config
	// subtree is mistaken for vault content (hex32-titled history pages get
	// pulled in as notes).
	return (
		isReservedPage(info) ||
		sys.has(hex(info.id)) ||
		(info.parent !== null && sys.has(info.parent))
	);
}

/** Reserved containers carry one of these icons; the title prefix is a
 * fallback for listings that omit the icon. */
const RESERVED_ICONS = ["\u{1F9FE}", "\u{1F5C4}\u{FE0F}", "\u{2699}\u{FE0F}"];

export function isReservedTitle(title: string): boolean {
	const t = title.trimStart();
	return RESERVED_ICONS.some((e) => t.startsWith(e));
}

/** Reserved container check that prefers the authoritative icon and only
 * falls back to the title prefix when there is none. */
export function isReservedPage(info: PageInfo): boolean {
	return (
		(info.icon !== null && RESERVED_ICONS.includes(info.icon)) ||
		isReservedTitle(info.title)
	);
}

/** A history-version page that ended up inside the vault tree instead of
 * under the 🗄️ container: its title is the hex32 page id of another page
 * in the tree (only the version writer uses hex32 titles) and it carries
 * no vault icon. Such a page is never vault content. */
export function isOrphanVersionPage(
	info: PageInfo,
	treeIds: ReadonlySet<string>,
): boolean {
	if (info.icon !== null) return false;
	const t = info.title.trim().toLowerCase();
	if (!/^[0-9a-f]{32}$/.test(t)) return false;
	return t !== hex(info.id) && treeIds.has(t);
}

export function nameFor(info: PageInfo, entry: SyncEntry | undefined): string {
	if (entry && info.title === entry.notionTitle)
		return entry.path.split("/").pop()!;
	const t = sanitizeTitle(info.title);
	return entry?.kind === "note" ? `${t}.md` : t;
}

export function entrySha(entry: SyncEntry): string | null {
	return entry.srcSha ?? entry.localHash ?? entry.fileSha ?? null;
}

/** null when the parent chain doesn't reach our tree within 3 hops.
 * ids known outside the tree are cached in `outside` (persisted to
 * state.outsideTree by the caller) so repeat hits cost zero requests. */
export async function parentInTree(
	deps: SyncDeps,
	info: PageInfo,
	outside: Set<string>,
): Promise<boolean> {
	const rootHex = hex(deps.state.rootPageId);
	const chain: string[] = [hex(info.id)];
	let pid = info.parent;
	for (let i = 0; pid && i < PARENT_CHAIN_MAX; i++) {
		if (pid === rootHex || deps.state.entries[pid]) return true;
		if (outside.has(pid)) {
			chain.forEach((c) => outside.add(c));
			return false;
		}
		chain.push(pid);
		const p = await getPage(deps.client, pid);
		pid = p?.parent ?? null;
	}
	chain.forEach((c) => outside.add(c));
	return false;
}

export interface SearchAuditCtx {
	rootHex: string;
	/** reserved system-page ids —extended in place when the scan
	 * discovers roots/subtrees the state didn't know yet. */
	sys: Set<string>;
	/** outsideTree cache (persisted by the caller). */
	outside: Set<string>;
	remote: Record<string, Side>;
	fetchedMeta: Map<string, { title?: string }>;
}

export interface SearchAudit {
	/** unknown in-tree hits as walkTree-shaped nodes for evalNew —	 * the icon-derived kind means no extra classifyPage GET. */
	adds: Node[];
	/** every entry id verified still in the tree this round. */
	seenIds: Set<string>;
	/** metadata the scan already paid for, keyed by hex id —lets the
	 * evaluate phase skip its own GET /pages for these ids. */
	pages: Map<string, PageInfo>;
}

/** Full structural audit via paginated POST /search.
 *
 * Sort MUST be descending: an ascending `last_edited_time` sort makes
 * /search return a single truncated page on some workspaces (probed:
 * 45 of 879 pages, all database rows, `has_more: false`), which would
 * look like a workspace-wide deletion.
 *
 * Returns null when the scan can't be trusted —the caller then falls
 * back to walkTree. Throws on API errors (also ->fallback). */
export async function auditSearchScan(
	deps: SyncDeps,
	ctx: SearchAuditCtx,
): Promise<SearchAudit | null> {
	const state = deps.state;
	const { rootHex, sys, remote, fetchedMeta } = ctx;

	// ---- paginate ----
	const infos: PageInfo[] = [];
	let cursor: string | undefined;
	let complete = false;
	for (
		let page = 0;
		page < AUDIT_SEARCH_MAX_PAGES && !complete;
		page++
	) {
		const res = await deps.client.request<{
			results?: Array<Parameters<typeof pageInfo>[0]>;
			next_cursor?: string | null;
			has_more?: boolean;
		}>("POST", "/search", {
			filter: { property: "object", value: "page" },
			sort: { direction: "descending", timestamp: "last_edited_time" },
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
		});
		for (const raw of res.results ?? []) infos.push(pageInfo(raw));
		deps.event?.({
			t: "scan",
			stage: "walk",
			done: infos.length,
			label: `搜索审计 ${infos.length} 页`,
		});
		if (!res.has_more) {
			complete = true;
			break;
		}
		cursor = res.next_cursor ?? undefined;
		if (!cursor) break; // can't page further -> incomplete
	}
	if (!complete) {
		deps.log?.(
		`audit: /search still paged after ${AUDIT_SEARCH_MAX_PAGES} requests - tree-walk fallback`,
		);
		return null;
	}
	deps.event?.({
		t: "scan",
		stage: "walk",
		done: infos.length,
		label: "done",
	});

	// ---- trashed hits + system subtrees ----
	// Icons declare the system roots, so they must be recorded before any
	// child is judged; the fixpoint then prunes whole subtrees, not just
	// direct children.
	const live = infos.filter((i) => !i.inTrash);
	for (const i of live) {
		if (i.icon === "\u{1F9FE}") state.journalId ??= hex(i.id);
		if (i.icon === "\u{1F5C4}\u{FE0F}") state.historyRootId ??= hex(i.id);
		if (i.icon === "\u{2699}\u{FE0F}") state.configRootId ??= hex(i.id);
	}
	for (const id of [state.journalId, state.historyRootId, state.configRootId]) {
		if (id) sys.add(hex(id));
	}
	// Every reserved page the workspace shows is a system root, recorded in
	// this state or not — the fixpoint below then prunes its whole subtree.
	for (const i of live) {
		if (isReservedPage(i)) sys.add(hex(i.id));
	}
	let grew = true;
	while (grew) {
		grew = false;
		for (const i of live) {
			const id = hex(i.id);
			if (!sys.has(id) && i.parent !== null && sys.has(i.parent)) {
				sys.add(id);
				grew = true;
			}
		}
	}
	const usable = live.filter((i) => !isSystemPage(i, sys));


	// ---- heavy-parent correction ----
	// /search truncates a parent's children once that parent is large
	// (probed live: a 107-child folder came back with 99). Re-read the
	// children of every heavy parent through the authoritative endpoint
	// and append whatever /search missed.
	const childCount = new Map<string, number>();
	for (const i of usable) {
		if (i.parent === null) continue;
		childCount.set(i.parent, (childCount.get(i.parent) ?? 0) + 1);
	}
	const known = new Set(usable.map((i) => hex(i.id)));
	const heavyParents = [...childCount.entries()]
		.filter(([, n]) => n >= HEAVY_PARENT_THRESHOLD)
		.map(([pid]) => pid);
	let recovered = 0;
	await runPool(heavyParents, 3, async (pid) => {
		const listed = await listChildPages(deps.client, pid).catch(
			() => [],
		);
		for (const c of listed) {
			const cid = hex(c.id);
			if (known.has(cid) || sys.has(cid)) continue;
			known.add(cid);
			usable.push({
				id: cid,
				parent: pid,
				inTrash: false,
				title: c.title,
				icon: null,
				lastEdited: c.lastEdited,
			});
			recovered++;
		}
	});
	if (recovered > 0) {
		deps.log?.(
			`audit: ${heavyParents.length} heavy parents —recovered ${recovered} pages /search dropped`,
		);
	}
	const byId = new Map(usable.map((i) => [hex(i.id), i] as const));

	// ---- in-tree resolution from the scanned parent map ----
	// The scan already holds every page the connection can see, so each
	// parent chain is fully resolvable in memory. The previous fixpoint
	// spent up to 3 GET /pages per unresolvable hit —measured at 43 GETs
	// for a 5-note first sync, because /search returns the whole workspace
	// while the vault tree is only a slice of it.
	//
	// A page parented by a block (not a page) carries `parent: null` and
	// stays outside, exactly as the old parent-chain probe decided.
	const parentOf = new Map<string, string | null>();
	for (const i of usable) {
		const id = hex(i.id);
		// A page parented by a block (not a page) reports no page_id;
		// normalise the empty/invalid forms to null so the chain stops.
		parentOf.set(id, i.parent ? hex(i.parent) : null);
	}
	parentOf.set(rootHex, null);

	const inTreeMemo = new Map<string, boolean>();
	const resolveInTree = (start: string): boolean => {
		const chain: string[] = [];
		let cur: string | null = start;
		let result = false;
		while (cur !== null && cur !== "") {
			const cached = inTreeMemo.get(cur);
			if (cached !== undefined) {
				result = cached;
				break;
			}
			if (cur === rootHex || state.entries[cur] !== undefined) {
				result = true;
				break;
			}
			if (chain.includes(cur)) break; // cycle ->outside
			chain.push(cur);
			if (!parentOf.has(cur)) break; // chain leaves the map ->outside
			cur = parentOf.get(cur) ?? null;
		}
		for (const c of chain) inTreeMemo.set(c, result);
		return result;
	};
	const inTree = new Set<string>();
	for (const i of usable) {
		const id = hex(i.id);
		// The root page is the tree, never one of its own children.
		if (id === rootHex) continue;
		if (resolveInTree(id)) inTree.add(id);
	}

	// ---- walkTree-shaped nodes for the unknown-hit evals; parents are
	// linked so evalNew's ParentRef derivation sees real chains. ----
	const nodes = new Map<string, Node>();
	const stub = (id: string): Node => ({
		pageId: id,
		title: "",
		kind: "note",
		parent: null,
		hasChildren: false,
		path: "",
	});
	const nodeFor = (info: PageInfo): Node => {
		const id = hex(info.id);
		const cached = nodes.get(id);
		if (cached) return cached;
		const n: Node = {
			pageId: id,
			title: info.title,
			kind:
				info.icon === "\u{1F4C1}"
					? "folder"
					: info.icon === "\u{1F4CE}"
						? "file"
						: "note",
			parent: null,
			hasChildren: false,
			path: "",
			lastEdited: info.lastEdited,
		};
		nodes.set(id, n);
		const p = info.parent;
		if (p !== null && p !== rootHex) {
			const pi = byId.get(p);
			n.parent =
				pi !== undefined && inTree.has(p) ? nodeFor(pi) : stub(p);
		}
		return n;
	};

	// ---- diff against the merge base ----
	const adds: Node[] = [];
	const seenIds = new Set<string>();
	const orphans: string[] = [];
	for (const i of usable) {
		const id = hex(i.id);
		if (!inTree.has(id)) continue;
		seenIds.add(id);
		const entry = state.entries[id];
		if (isOrphanVersionPage(i, inTree)) {
			// version page in the wrong place — drop the vault copy, and
			// take the stray page out of the tree so it stops coming back
			if (entry) remote[id] = { deleted: true };
			orphans.push(id);
			continue;
		}
		if (!entry) {
			adds.push(nodeFor(i));
			continue;
		}
		// NOTE: entry.remoteEdited is deliberately NOT stamped here. The scan
		// only compares STRUCTURE (parent/name) — a page whose content changed
		// but whose parent/name did not would otherwise be marked "already
		// evaluated", and the next round's search gate (remoteEdited ===
		// last_edited_time) would skip it forever, losing the edit. It is
		// stamped in the evaluate phase once content is actually compared
		// (also covers the round-robin / walk-fallback paths).
		// Structure compare needs a real page parent: root, a known entry,
		// or another in-tree hit. A block/hidden parent can't prove a move.
		const p = i.parent;
		if (
			p === null ||
			(p !== rootHex &&
				state.entries[p] === undefined &&
				!inTree.has(p))
		) {
			continue;
		}
		const name = nameFor(i, entry);
		if (
			hex(p) !== hex(entry.parentId) ||
			name !== entry.path.split("/").pop()
		) {
			// structure changed —keep base sha, content is not evaluated here
			remote[id] = {
				deleted: false,
				parent: { id: p },
				name,
				sha: entrySha(entry),
			};
			fetchedMeta.set(id, { title: i.title });
		}
	}

	// ---- deletions: never trust the search index —every entry missing
	// from the scan is confirmed with a direct GET before marking. A big
	// gap means the scan itself is broken, and confirming thousands of
	// entries one by one is both slow and wrong. ----
	const entryIds = Object.keys(state.entries);
	const unseen = entryIds.filter((id) => !seenIds.has(id));
	if (
		unseen.length > AUDIT_CONFIRM_MAX &&
		seenIds.size / Math.max(1, entryIds.length) < AUDIT_MIN_COVERAGE
	) {
		deps.log?.(
			`audit: /search covered ${seenIds.size}/${entryIds.length} entries ` +
				`(< ${Math.round(AUDIT_MIN_COVERAGE * 100)}%) —tree-walk fallback`,
		);
		return null;
	}
	for (const id of unseen) {
		const p = await getPage(deps.client, id);
		if (p === null || p.inTrash) {
			remote[id] = { deleted: true };
		} else {
			// index lag —still in the tree, structure assumed unchanged.
			// remoteEdited stays untouched: this GET proves existence only,
			// the content was not compared (see the note above).
			seenIds.add(id);
		}
	}

	// ---- stray version pages: trash them remotely (bounded) ----
	// Only reachable by mistake (a container that was trashed or never
	// recorded), and they carry no vault content of their own — but they
	// clutter the tree until removed.
	if (orphans.length > 0) {
		deps.log?.(
			`audit: ${orphans.length} stray version page(s) in the tree — trashing`,
		);
		for (const id of orphans.slice(0, ORPHAN_TRASH_MAX)) {
			try {
				await deps.client.request("PATCH", `/pages/${id}`, {
					in_trash: true,
				});
			} catch (err) {
				deps.log?.(
					`audit: trash ${id} failed (${String(err)})`,
				);
			}
		}
	}

	return { adds, seenIds, pages: new Map(usable.map((i) => [hex(i.id), i])) };
}
