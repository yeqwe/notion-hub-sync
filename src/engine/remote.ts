// Remote snapshot: build the remote side for plan() by reading the change
// journal, the search API (best-effort for human Notion-UI edits), a
// round-robin sample, and full structural audits. Since last_edited_time
// is unreliable (minute-rounded, not bumped by API writes), content is
// compared by sha, not timestamps.

import { sha256Hex } from "../sync/hashes";
import {
	splitPageMarkdown,
	visibleHash,
	decidePullContent,
	summaryLine,
} from "../sync/toggle";
import { notionToObsidian } from "../convert/notion-to-obsidian";
import { renderMatchesSource } from "../sync/source-compare";
import type { LinkResolver } from "../convert/links";
import { sanitizeTitle } from "../sync/paths";
import { walkTree, type Node } from "../sync/pull";
import { captionSha } from "../sync/upload";
import type { SyncDeps } from "../sync/deps";
import { runPool, mapConcurrent, CONTENT_BUDGET, sizeOrUnknown } from "../sync/pool";
import type { SyncEntry } from "../sync/state";
import type { ParentRef, RemoteAdded, Side } from "./types";
import { readJournal } from "./journal";
import {
	auditSearchScan,
	entrySha,
	getPage,
	hex,
	isSystemPage,
	nameFor,
	pageInfo,
	parentInTree,
	systemRootIds,
	SEARCH_MAX_PAGES,
	type PageInfo,
	type SearchAudit,
} from "./remote-audit";

const SEARCH_CURSOR_GRACE_MS = 10 * 60_000;

export interface RemoteSnapshot {
	remote: Record<string, Side>;
	remoteAdded: RemoteAdded[];
	/** bytes already fetched during evaluation (id → content). */
	fetchedBytes: Map<string, Uint8Array>;
	/** fresh remote metadata per evaluated id (for base update). */
	fetchedMeta: Map<
		string,
		{
			visSha?: string;
			mediaBlockId?: string | null;
			title?: string;
			lastEdited?: string;
		}
	>;
	/** every page id verified in-tree this audit (search scan or walk). */
	seenIds: Set<string> | null;
	auditDue: boolean;
	/** audit-only diagnostic: a note/file page that grew child pages
	 * (they sync into a sibling folder of the same name). */
	nestedUnderPage?: Array<{ title: string; count: number }>;
	journalSeen: string[];
	searchCursor: string | undefined;
	/** ids from journal ops this round (for config sync). */
	journalCandidateIds: string[];
}

export interface RemoteOptions {
	full: boolean; // "Full sync" command
	/** Enumerate the whole remote tree this round even when the audit timer
	 * hasn't expired — used on a cold start, where there is no base to
	 * compare against and the tree has to be re-matched by path from
	 * scratch. Unlike `full` this does not disable the incremental search
	 * pass, so the next round keeps its cursor. */
	forceAudit?: boolean;
	roundRobinPerRound: number;
	fullAuditHours: number;
	links: LinkResolver;
	now: number;
}

export async function snapshotRemote(
	deps: SyncDeps,
	opts: RemoteOptions,
): Promise<RemoteSnapshot> {
	const remote: Record<string, Side> = {};
	const remoteAdded: RemoteAdded[] = [];
	const fetchedBytes = new Map<string, Uint8Array>();
	const fetchedMeta: RemoteSnapshot["fetchedMeta"] = new Map();
	const state = deps.state;
	const rootHex = hex(state.rootPageId);
	const sys = systemRootIds(state);

	const candidates = new Set<string>();
	const outside = new Set(state.outsideTree ?? []);
	let auditDue =
		opts.full ||
		opts.forceAudit === true ||
		state.lastFullAudit === undefined ||
		opts.now - state.lastFullAudit > opts.fullAuditHours * 3_600_000;

	// ---- journal ----
	// A device that has never synced doesn't know the journal page id yet;
	// the audit discovers it from the root's children listing it performs
	// anyway. Until then readJournal has nothing to read — no extra request
	// is spent here.
	const jr = await readJournal(
		deps.client,
		state.journalId,
		deps.deviceId.slice(0, 8),
		state.journalSeen ?? [],
		opts.full,
	);
	for (const id of jr.candidateIds) candidates.add(id);
	if (jr.gap) auditDue = true;

	// ---- search (best-effort human edits) ----
	// No cursor yet + audit due → the tree walk finds everything anyway;
	// skip the search (every hit would cost 1–3 parentInTree GETs).
	if (!opts.full && !(state.searchCursor === undefined && auditDue)) {
		const since = state.searchCursor
			? Date.parse(state.searchCursor) - SEARCH_CURSOR_GRACE_MS
			: -Infinity;
		let cursor: string | undefined;
		let maxEdited = state.searchCursor;
		let done = false;
		for (let page = 0; page < SEARCH_MAX_PAGES && !done; page++) {
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
			const results = res.results ?? [];
			for (const raw of results) {
				const info = pageInfo(raw);
				const edited = info.lastEdited;
				if (edited) {
					if (!maxEdited || edited > maxEdited) maxEdited = edited;
					if (Date.parse(edited) < since) {
						done = true;
						break;
					}
				}
				const pid = hex(info.id);
				if (isSystemPage(info, sys)) continue;
				const entry = state.entries[pid];
				if (entry) {
					// API edits don't bump last_edited_time, so an unchanged
					// timestamp means "we already evaluated this page".
					// remoteEdited is stamped in the evaluate phase, after the
					// content comparison — stamping it here would mark the page
					// evaluated even if its evaluation then failed.
					if (edited && entry.remoteEdited === edited) continue;
					candidates.add(pid);
				} else if (await parentInTree(deps, info, outside)) {
					candidates.add(pid);
				}
			}
			if (done || !res.has_more) {
				done = true;
				break;
			}
			cursor = res.next_cursor ?? undefined;
			if (!cursor) {
				done = true;
				break;
			}
		}
		state.searchCursor = maxEdited;
		if (!done) auditDue = true; // exhausted all search pages
	} else if (!opts.full && state.searchCursor === undefined) {
		// skipped first search — start the cursor now so the next round
		// only searches from here
		state.searchCursor = new Date(opts.now).toISOString();
	}

	// ---- round-robin ----
	// RR-only candidates get a cheaper eval: files detect remote deletion via
	// the content call (children 404 on trashed pages — probed), so the
	// GET /pages step is skipped for them. Notes still need GET /pages
	// (markdown returns 200 on trashed pages — probed).
	const rrOnly = new Set<string>();
	if (opts.roundRobinPerRound > 0) {
		const rr = Object.entries(state.entries)
			.filter(([, e]) => e.kind !== "folder")
			.sort((a, b) => (a[1].checkedAt ?? 0) - (b[1].checkedAt ?? 0))
			.slice(0, opts.roundRobinPerRound);
		for (const [id] of rr) {
			if (!candidates.has(id)) rrOnly.add(id);
			candidates.add(id);
		}
	}

	// ---- full audit (structure) ----
	// Primary path: paginated POST /search scan (~1 request per 100 pages).
	// Fallback: the per-parent children walk — used when /search fails or
	// the workspace doesn't fit the page cap.
	let seenIds: Set<string> | null = null;
	const auditAdds: Node[] = [];
	/** metadata the audit already fetched — the evaluate phase reuses it
	 * instead of paying another GET /pages per id. */
	let auditPages: Map<string, PageInfo> | null = null;
	/** note/file pages that grew child pages — surfaced as a round warning. */
	let nestedUnderPage: Array<{ title: string; count: number }> | undefined;
	if (auditDue) {
		let scanned: SearchAudit | null = null;
		try {
			scanned = await auditSearchScan(deps, {
				rootHex,
				sys,
				outside,
				remote,
				fetchedMeta,
			});
		} catch (err) {
			deps.log?.(
				`audit: /search scan failed (${err instanceof Error ? err.message : String(err)}) — tree-walk fallback`,
			);
		}
		if (scanned !== null) {
			auditAdds.push(...scanned.adds);
			seenIds = scanned.seenIds;
			auditPages = scanned.pages;
			nestedUnderPage = childPagesUnderNotes(state, scanned.pages);
			deps.log?.(
				`audit: search ${seenIds.size} in-tree, ${scanned.adds.length} new`,
			);
		} else {
			const nodes: Node[] = [];
			let walked = 0;
			let lastWalkEmit = 0;
			await walkTree(deps, rootHex, null, nodes, (n) => {
				walked++;
				const t = deps.now?.() ?? Date.now();
				if (walked === 1 || walked % 25 === 0 || t - lastWalkEmit > 200) {
					lastWalkEmit = t;
					deps.event?.({
						t: "scan",
						stage: "walk",
						done: walked,
						label: n.title || n.pageId,
					});
				}
			});
			deps.event?.({
				t: "scan",
				stage: "walk",
				done: walked,
				label: "done",
			});
			seenIds = new Set(nodes.map((n) => n.pageId));
			deps.log?.(`audit: ${nodes.length} nodes: ${nodes.map((n) => `${n.title}(${n.kind})`).join(", ")}`);
			for (const n of nodes) {
				const entry = state.entries[n.pageId];
				if (!entry) {
					auditAdds.push(n);
					continue;
				}
				// remoteEdited is NOT stamped here — the walk only compares
				// structure; content is compared in the evaluate phase.
				const name = nameFor(
					{ id: n.pageId, parent: n.parent?.pageId ?? null, inTrash: false, title: n.title, icon: null },
					entry,
				);
				const parentId = n.parent?.pageId ?? rootHex;
				if (
					hex(parentId) !== hex(entry.parentId) ||
					name !== entry.path.split("/").pop()
				) {
					// structure changed — content not evaluated here; keep base sha
					remote[n.pageId] = {
						deleted: false,
						parent: { id: parentId },
						name,
						sha: entrySha(entry),
					};
					fetchedMeta.set(n.pageId, { title: n.title });
				}
			}
			for (const id of Object.keys(state.entries)) {
				if (!seenIds.has(id)) {
					remote[id] = { deleted: true };
				}
			}
		}
		// The audit snapshot is complete — record it NOW so an interrupt
		// during eval/apply doesn't re-walk the whole tree next round.
		state.lastFullAudit = opts.now;
		await deps.saveState();
	}

	// ---- evaluate candidates (parallel, pool of 3) ----
	// A page whose parent is itself a pending unknown id maps to
	// {newRemote} even if the parent's eval hasn't finished yet.
	const pendingNew = new Set([
		...candidates,
		...auditAdds.map((n) => n.pageId),
	]);
	const evalTotal = Math.max(
		0,
		candidates.size + auditAdds.length - rrOnly.size,
	);
	let evalDone = 0;
	/** Report progress for real changes only. Round-robin candidates are a
	 * silent correctness backstop: when the user changed nothing, nothing
	 * should appear to be happening — a "6/10" readout on an idle round
	 * would advertise the spot-check machinery for no reason. */
	const evalTick = (id: string, label: string): void => {
		if (rrOnly.has(id)) return; // spot check — never counted or shown
		evalDone++;
		// nothing real to report (spot-check-only round) → stay silent
		if (evalTotal === 0) return;
		deps.event?.({
			t: "scan",
			stage: "evaluate",
			done: evalDone,
			total: evalTotal,
			label,
		});
	};
	// Byte budget, not item count: "3 at a time" is fine for 1 KB notes and
	// fatal for three 200 MB videos (600 MB of live buffers on a phone).
	const budget = {
		sizeOf: (id: string) => sizeOrUnknown(state.entries[id]?.localSize),
		budgetBytes: deps.isMobile
			? CONTENT_BUDGET.mobile
			: CONTENT_BUDGET.desktop,
	};
	await mapConcurrent(
		[...candidates],
		3,
		async (id) => {
		const entry = state.entries[id];
		evalTick(id, entry?.path ?? id);
		// Out of scope: never evaluated, so it stays "unchanged" for the
		// planner and nothing is downloaded, pushed or deleted for it.
		if (deps.scope && entry && !deps.scope.allows(entry.path, entry.kind === "folder")) {
			return;
		}
		if (remote[id]?.deleted === true) return; // already known gone
		// Round-robin files: the children call 404s on trashed pages
		// (verified live) — skip the GET /pages entirely.
		if (rrOnly.has(id) && entry?.kind === "file") {
			try {
				const r = await evalFile(deps, id, entry);
				remote[id] = {
					deleted: false,
					parent: {
						id:
							hex(entry.parentId) === rootHex
								? "root"
								: hex(entry.parentId),
					},
					name: entry.path.split("/").pop()!,
					sha: r.sha,
				};
				if (r.bytes) fetchedBytes.set(id, r.bytes);
				fetchedMeta.set(id, { ...fetchedMeta.get(id), ...r.meta });
			} catch {
				remote[id] = { deleted: true };
			}
			entry.checkedAt = opts.now;
			return;
		}
		const info =
			entry !== undefined
				? auditPages?.get(id) ?? (await getPage(deps.client, id))
				: await getPage(deps.client, id);
		if (!info || info.inTrash) {
			if (entry) remote[id] = { deleted: true };
			return;
		}
		if (isSystemPage(info, sys)) {
			// a page that drifted into a system subtree: nothing to sync, but
			// stamp checkedAt or it hogs a round-robin slot every round.
			if (entry) entry.checkedAt = opts.now;
			return;
		}
		if (info.lastEdited) {
			// fetchedMeta still carries the timestamp (apply reads it to seed
			// newly discovered/created entries), but entry.remoteEdited is
			// stamped only AFTER the content comparison below — stamping it
			// first would make an evaluation error look like a completed
			// check, and the next round's search gate would skip the page.
			fetchedMeta.set(id, {
				...fetchedMeta.get(id),
				lastEdited: info.lastEdited,
			});
		}
		if (!entry) {
			// unknown id (journal "n", search hit) → remote-added if in tree
			const r = await evalNewPage(
				deps,
				info,
				remoteAdded,
				opts.links,
				pendingNew,
			);
			if (r && !remoteAdded.some((a) => a.id === r.id)) {
				remoteAdded.push(r);
			}
			return;
		}
		const parent = parentRef(
			info.parent,
			rootHex,
			state,
			remoteAdded,
			pendingNew,
		);
		if (parent === null) {
			remote[id] = { deleted: true }; // moved outside our tree
			return;
		}
		const side: Side = {
			deleted: false,
			parent,
			name: nameFor(info, entry),
			sha: entrySha(entry),
		};
		if (entry.kind === "note") {
			const r = await evalNote(deps, id, entry, opts.links);
			side.sha = r.sha;
			if (r.bytes) fetchedBytes.set(id, r.bytes);
			fetchedMeta.set(id, { ...fetchedMeta.get(id), ...r.meta });
		} else if (entry.kind === "file") {
			const r = await evalFile(deps, id, entry);
			side.sha = r.sha;
			if (r.bytes) fetchedBytes.set(id, r.bytes);
			fetchedMeta.set(id, { ...fetchedMeta.get(id), ...r.meta });
		}
		remote[id] = side;
		// content (note markdown / file bytes) has now been compared — only
		// here is it safe to tell the search gate "this page is evaluated".
		if (info.lastEdited) entry.remoteEdited = info.lastEdited;
		entry.checkedAt = opts.now;
		},
		budget,
	);

	// ---- remote added: audit-discovered + candidate-unknowns ----
	await runPool(auditAdds, 3, async (n) => {
		evalTick(n.pageId, n.title || n.pageId);
		const r = await evalNew(
			deps,
			n,
			remoteAdded,
			opts.links,
			pendingNew,
		);
		if (r && !remoteAdded.some((a) => a.id === r.id)) {
			remoteAdded.push(r);
		}
	});

	// persist the outside-tree cache (FIFO, capped)
	if (outside.size > 0) {
		state.outsideTree = [...outside].slice(-2000);
	}

	return {
		remote,
		remoteAdded,
		fetchedBytes,
		fetchedMeta,
		seenIds,
		auditDue,
		nestedUnderPage,
		journalSeen: jr.newSeen,
		searchCursor: state.searchCursor,
		journalCandidateIds: jr.candidateIds,
	};
}

function parentRef(
	parentId: string | null,
	rootHex: string,
	state: { entries: Record<string, SyncEntry> },
	remoteAdded: RemoteAdded[],
	pendingNew?: Set<string>,
): ParentRef | null {
	if (parentId === null || parentId === rootHex) return { id: "root" };
	if (state.entries[parentId]) return { id: parentId };
	if (
		remoteAdded.some((a) => a.id === parentId) ||
		pendingNew?.has(parentId)
	) {
		return { newRemote: parentId };
	}
	return null;
}

async function evalNote(
	deps: SyncDeps,
	id: string,
	entry: SyncEntry,
	links: LinkResolver,
): Promise<{
	sha: string | null;
	bytes?: Uint8Array;
	meta: { visSha?: string; srcSha?: string };
}> {
	const res = await deps.client.request<{ markdown?: string }>(
		"GET",
		`/pages/${id}/markdown`,
	);
	const split = await splitPageMarkdown(res.markdown ?? "");
	const visSha = await visibleHash(split.visible);
	const baseSha = entrySha(entry);
	// Empty remote shell (e.g. a page created by an interrupted push whose
	// content never landed): treat as "no remote content" when we have no
	// base sha — local wins instead of producing a conflict/pull.
	if (baseSha === null && !split.source && split.visible.trim() === "") {
		return { sha: null, meta: { visSha } };
	}
	const s = split.source;
	if (s && s.srcSha === baseSha && baseSha !== null && s.bytes !== null) {
		if (
			s.visSha !== null &&
			s.visSha === entry.visSha &&
			visSha === entry.visSha
		) {
			return { sha: baseSha, meta: { visSha } };
		}
		// The remote still carries our source (srcSha matches base), but
		// the rendered visible differs from what we recorded — either
		// Notion re-normalized the page after our write, or a human
		// edited it in the Notion UI. Both sides' visible text goes
		// through the same lossy conversion, so real edits stay
		// detectable while render drift converges.
		if (renderMatchesSource(s.bytes, split.visible, links, entry.path)) {
			if (s.visSha !== visSha) {
				// repair the summary VIS so other devices take the
				// lossless source path on their next pull
				await repairSummaryVis(
					deps,
					res.markdown ?? "",
					id,
					s.srcSha,
					visSha,
				);
			}
			entry.visSha = visSha;
			return { sha: baseSha, meta: { visSha } };
		}
	}
	const decision = decidePullContent(split, visSha);
	const bytes =
		decision.kind === "source"
			? decision.bytes
			: new TextEncoder().encode(
					notionToObsidian(split.visible, { links }),
				);
	return {
		sha: await sha256Hex(bytes),
		bytes,
		meta: { visSha, srcSha: split.source?.srcSha },
	};
}

async function evalFile(
	deps: SyncDeps,
	id: string,
	entry: SyncEntry,
): Promise<{
	sha: string | null;
	bytes?: Uint8Array;
	meta: { mediaBlockId?: string | null };
}> {
	const children = await deps.client.request<{
		results?: Array<{ id: string; type: string; [k: string]: unknown }>;
	}>("GET", `/blocks/${id}/children?page_size=100`);
	const media = (children.results ?? []).find((b) =>
		["image", "pdf", "audio", "video", "file"].includes(b.type),
	);
	const blockId = media ? hex(media.id) : null;
	const baseSha = entrySha(entry);
	if (blockId && blockId === entry.mediaBlockId && baseSha) {
		return { sha: baseSha, meta: { mediaBlockId: blockId } };
	}
	// exact: our uploads stamp the content sha in the media caption —
	// a new block id + caption sha = the remote bytes hash, no download
	const cap = media ? captionSha(media) : null;
	if (cap) {
		return { sha: cap, meta: { mediaBlockId: blockId } };
	}
	const url = (
		media?.[media.type as keyof typeof media] as
			| { file?: { url?: string } }
			| undefined
	)?.file?.url;
	if (!url) {
		return { sha: baseSha, meta: { mediaBlockId: blockId } };
	}
	const bytes = new Uint8Array(
		await deps.client.download(url, { sizeHintBytes: entry.localSize }),
	);
	return {
		sha: await sha256Hex(bytes),
		bytes,
		meta: { mediaBlockId: blockId },
	};
}

/** Note/file pages that grew child pages (possible by hand in Notion,
 * where any page can hold child pages). Such children sync into a
 * sibling directory of the same name (`a/b.md` → `a/b/`), so the layout
 * is valid — but surprising enough to report once per audit. */
export function childPagesUnderNotes(
	state: { entries: Record<string, SyncEntry> },
	pages: Map<string, PageInfo>,
): Array<{ title: string; count: number }> | undefined {
	const counts = new Map<string, number>();
	for (const [id, info] of pages) {
		const parent = info.parent;
		if (parent === null || parent === id) continue;
		const entry = state.entries[parent];
		// only a synced note/file turns a child into a folder-note layout
		if (!entry || (entry.kind !== "note" && entry.kind !== "file")) continue;
		counts.set(parent, (counts.get(parent) ?? 0) + 1);
	}
	if (counts.size === 0) return undefined;
	return [...counts.entries()].map(([id, count]) => ({
		title: pages.get(id)?.title || state.entries[id]?.path || id,
		count,
	}));
}

/** Fix the source-toggle summary's `visible:` hash after Notion-side
 * render drift: one update_content replacing the exact summary line. */
async function repairSummaryVis(
	deps: SyncDeps,
	rawMarkdown: string,
	id: string,
	srcSha: string,
	visSha: string,
): Promise<void> {
	const m = rawMarkdown.match(
		/<summary>🔒 obsidian-source v1 sha256:[0-9a-f]{64}(?: visible:[0-9a-f]{64})?<\/summary>/,
	);
	if (!m) return;
	try {
		await deps.client.request("PATCH", `/pages/${id}/markdown`, {
			type: "update_content",
			update_content: {
				content_updates: [
					{ old_str: m[0], new_str: summaryLine(srcSha, visSha) },
				],
			},
		});
	} catch {
		// best-effort: an unrepaired summary just costs a repeat check
	}
}

/** Evaluate an unknown-id page discovered via journal/search. */
async function evalNewPage(
	deps: SyncDeps,
	info: PageInfo,
	remoteAdded: RemoteAdded[],
	links: LinkResolver,
	pendingNew?: Set<string>,
): Promise<RemoteAdded | null> {
	const icon = info.icon;
	if (icon === "🧾") deps.state.journalId = hex(info.id);
	if (icon === "🗄️") deps.state.historyRootId = hex(info.id);
	if (icon === "⚙️") deps.state.configRootId = hex(info.id);
	const kind =
		icon === "📁"
			? "folder"
			: icon === "📎"
				? "file"
				: icon === "⚙️" || icon === "🗄️" || icon === "🧾"
					? null
					: "note";
	if (kind === null) return null;
	const parent = parentRef(
		info.parent,
		hex(deps.state.rootPageId),
		deps.state,
		remoteAdded,
		pendingNew,
	);
	if (parent === null) return null;
	const name =
		kind === "note"
			? `${sanitizeTitle(info.title)}.md`
			: sanitizeTitle(info.title);
	const sha = await evalNewSha(deps, info.id, kind, links);
	return {
		id: hex(info.id),
		kind,
		parent,
		name,
		sha,
		lastEdited: info.lastEdited,
	};
}

async function evalNewSha(
	deps: SyncDeps,
	id: string,
	kind: "folder" | "note" | "file",
	links: LinkResolver,
): Promise<string | null> {
	if (kind === "note") {
		const res = await deps.client.request<{ markdown?: string }>(
			"GET",
			`/pages/${id}/markdown`,
		);
		const split = await splitPageMarkdown(res.markdown ?? "");
		if (!split.source && split.visible.trim() === "") return null;
		const visSha = await visibleHash(split.visible);
		const decision = decidePullContent(split, visSha);
		let bytes: Uint8Array;
		if (decision.kind === "source") {
			bytes = decision.bytes;
		} else if (
			split.source?.bytes &&
			renderMatchesSource(split.source.bytes, split.visible, links)
		) {
			bytes = split.source.bytes;
		} else {
			bytes = new TextEncoder().encode(
				notionToObsidian(split.visible, { links }),
			);
		}
		return sha256Hex(bytes);
	}
	if (kind === "file") {
		const r = await evalFile(deps, id, {
			path: "",
			kind: "file",
			notionTitle: "",
			parentId: "",
		});
		return r.sha || null;
	}
	return null;
}

async function evalNew(
	deps: SyncDeps,
	node: Node,
	remoteAdded: RemoteAdded[],
	links: LinkResolver,
	pendingNew?: Set<string>,
): Promise<RemoteAdded | null> {
	// walkTree already classified this page (and recorded system ids in
	// its skip branch) — no need for another GET.
	const kind = node.kind;
	const parent = parentRef(
		node.parent?.pageId ?? null,
		hex(deps.state.rootPageId),
		deps.state,
		remoteAdded,
		pendingNew,
	);
	if (parent === null) return null;
	const name =
		kind === "note" ? `${sanitizeTitle(node.title)}.md` : sanitizeTitle(node.title);
	let sha: string | null = null;
	if (kind === "note") {
		const res = await deps.client.request<{ markdown?: string }>(
			"GET",
			`/pages/${node.pageId}/markdown`,
		);
		const split = await splitPageMarkdown(res.markdown ?? "");
		// empty remote shell (interrupted push): no remote content → local wins
		if (!(!split.source && split.visible.trim() === "")) {
			const visSha = await visibleHash(split.visible);
			const decision = decidePullContent(split, visSha);
			let bytes: Uint8Array;
			if (decision.kind === "source") {
				bytes = decision.bytes;
			} else if (
				split.source?.bytes &&
				renderMatchesSource(
					split.source.bytes,
					split.visible,
					links,
				)
			) {
				bytes = split.source.bytes;
			} else {
				bytes = new TextEncoder().encode(
					notionToObsidian(split.visible, { links }),
				);
			}
			sha = await sha256Hex(bytes);
		}
	} else if (kind === "file") {
		const r = await evalFile(deps, node.pageId, {
			path: "",
			kind: "file",
			notionTitle: "",
			parentId: "",
		});
		sha = r.sha || null;
	}
	return { id: node.pageId, kind, parent, name, sha, lastEdited: node.lastEdited };
}
