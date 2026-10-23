// Per-file version history stored in Notion itself:
//   root/🗄️ 同步历史 (notion-hub-sync)/<pageId hex32>  ← one history page
// each version = a media block (uploaded file bytes), newest first, with a
// compact JSON caption describing it. Content is downloaded on demand from
// the block's signed file.url.

import type { NotionClient } from "../notion/client";
import { sha256Hex } from "./hashes";
import { basename } from "./vault-io";
import { buildMultipart, planUpload } from "./upload";
import { ensureReservedPage } from "./reserved";
import type { SyncDeps } from "./deps";

/** What history recording actually needs — a SyncDeps subset so UI restore
 * paths (which lack resolvePath/vault) can call in too. */
export type HistoryDeps = Pick<
	SyncDeps,
	| "client"
	| "state"
	| "saveState"
	| "deviceId"
	| "history"
	| "historyPageCache"
	| "now"
	| "log"
	| "debug"
>;

export const HISTORY_CONTAINER_TITLE = "🗄️ 同步历史 (notion-hub-sync)";
export const HISTORY_CONTAINER_ICON = "🗄️";

const MAX_VERSION_BYTES = 20 * 1024 * 1024;
const MAX_RETENTION_DELETES = 5;
const VERSION_PAGE_SIZE = 50;

export type VersionReason = "push" | "pre-pull" | "pre-delete" | "restore";

export interface VersionCaption {
	v: 1;
	/** ISO timestamp. */
	t: string;
	/** deviceId first 8 chars. */
	d: string;
	/** sha256 of content. */
	s: string;
	/** byte size. */
	z: number;
	/** vault path at that time. */
	p: string;
	r: VersionReason;
}

export interface VersionInfo {
	blockId: string;
	url: string | null;
	caption: VersionCaption;
}

const MEDIA_TYPES = new Set(["image", "pdf", "audio", "video", "file"]);

export function encodeCaption(c: VersionCaption): string {
	return JSON.stringify(c);
}

/** Parse a block caption; non-v1 JSON / foreign blocks → null. */
export function parseCaption(text: string): VersionCaption | null {
	try {
		const obj = JSON.parse(text) as Partial<VersionCaption>;
		if (
			obj.v === 1 &&
			typeof obj.t === "string" &&
			typeof obj.d === "string" &&
			typeof obj.s === "string" &&
			typeof obj.z === "number" &&
			typeof obj.p === "string" &&
			typeof obj.r === "string"
		) {
			return obj as VersionCaption;
		}
	} catch {
		// not JSON
	}
	return null;
}

interface ChildBlock {
	id: string;
	type: string;
	in_trash?: boolean;
	[key: string]: unknown;
}

function captionOf(block: ChildBlock): string {
	const media = block[block.type] as
		| { caption?: Array<{ plain_text?: string; text?: { content?: string } }> }
		| undefined;
	return (media?.caption ?? [])
		.map((r) => r.plain_text ?? r.text?.content ?? "")
		.join("");
}

function fileUrlOf(block: ChildBlock): string | null {
	const media = block[block.type] as
		| { file?: { url?: string } }
		| undefined;
	return media?.file?.url ?? null;
}

/** One page of version blocks on a history page, newest first. */
export async function listVersions(
	client: NotionClient,
	historyPageId: string,
	cursor?: string,
): Promise<{
	versions: VersionInfo[];
	nextCursor: string | null;
	hasMore: boolean;
}> {
	const path =
		`/blocks/${historyPageId}/children?page_size=${VERSION_PAGE_SIZE}` +
		(cursor ? `&start_cursor=${cursor}` : "");
	const res = await client.request<{
		results?: ChildBlock[];
		next_cursor?: string | null;
		has_more?: boolean;
	}>("GET", path);
	const versions: VersionInfo[] = [];
	for (const b of res.results ?? []) {
		if (b.in_trash || !MEDIA_TYPES.has(b.type)) continue;
		const caption = parseCaption(captionOf(b));
		if (!caption) continue;
		versions.push({ blockId: b.id, url: fileUrlOf(b), caption });
	}
	return {
		versions,
		nextCursor: res.next_cursor ?? null,
		hasMore: res.has_more ?? false,
	};
}

/** Download a version's content bytes via its signed url. */
export async function downloadVersion(
	client: NotionClient,
	version: VersionInfo,
): Promise<Uint8Array> {
	if (!version.url) {
		throw new Error("version block has no file url");
	}
	return new Uint8Array(
		await client.download(version.url, {
			sizeHintBytes: version.caption.z,
		}),
	);
}

/** History pages under the container: title = pageId hex32 → page id. */
export async function listHistoryPages(
	client: NotionClient,
	containerId: string,
	cursor?: string,
): Promise<{
	pages: Array<{ id: string; title: string }>;
	nextCursor: string | null;
	hasMore: boolean;
}> {
	const path =
		`/blocks/${containerId}/children?page_size=100` +
		(cursor ? `&start_cursor=${cursor}` : "");
	const res = await client.request<{
		results?: Array<{
			id: string;
			type: string;
			in_trash?: boolean;
			child_page?: { title?: string };
		}>;
		next_cursor?: string | null;
		has_more?: boolean;
	}>("GET", path);
	const pages = (res.results ?? [])
		.filter((b) => b.type === "child_page" && !b.in_trash)
		.map((b) => ({ id: b.id, title: b.child_page?.title ?? "" }));
	return {
		pages,
		nextCursor: res.next_cursor ?? null,
		hasMore: res.has_more ?? false,
	};
}

/** Lazily create (or adopt an existing) 🗄️ container under the sync root. */
async function ensureHistoryRoot(deps: HistoryDeps): Promise<string> {
	return ensureReservedPage(
		deps,
		{ title: HISTORY_CONTAINER_TITLE, icon: HISTORY_CONTAINER_ICON },
		deps.state.historyRootId,
		(id) => {
			deps.state.historyRootId = id;
		},
	);
}

/** Find (or lazily create) the per-file history page, titled by pageId. */
export async function ensureHistoryPage(
	deps: HistoryDeps,
	pageId: string,
): Promise<string> {
	const entry = deps.state.entries[pageId];
	if (entry?.historyPageId) {
		return entry.historyPageId;
	}
	deps.historyPageCache ??= new Map();
	const cached = deps.historyPageCache.get(pageId);
	if (cached) {
		return cached;
	}
	const container = await ensureHistoryRoot(deps);
	// list the container once per run, cache every title→id we see
	if (!deps.historyPageCache.has("__loaded__")) {
		let cursor: string | undefined;
		do {
			const page = await listHistoryPages(deps.client, container, cursor);
			for (const p of page.pages) {
				deps.historyPageCache.set(
					p.title.toLowerCase(),
					p.id.replace(/-/g, "").toLowerCase(),
				);
			}
			cursor = page.hasMore ? (page.nextCursor ?? undefined) : undefined;
		} while (cursor);
		deps.historyPageCache.set("__loaded__", "1");
	}
	const found = deps.historyPageCache.get(pageId);
	if (found) {
		if (entry) entry.historyPageId = found;
		return found;
	}
	const res = await deps.client.request<{ id: string }>("POST", "/pages", {
		parent: { page_id: container },
		properties: { title: { title: [{ text: { content: pageId } }] } },
	});
	const id = res.id.replace(/-/g, "").toLowerCase();
	deps.historyPageCache.set(pageId, id);
	if (entry) {
		entry.historyPageId = id;
		await deps.saveState();
	}
	return id;
}

/**
 * Record one version of a file's content. Skips (returns "skipped") when
 * history is disabled, content too large, content sha unchanged, or — for
 * "push" only — inside the per-device interval. Everything else throws to
 * the caller (who must treat failures as warnings, never sync failures).
 */
export async function recordVersion(
	deps: HistoryDeps,
	pageId: string,
	path: string,
	bytes: Uint8Array,
	reason: VersionReason,
): Promise<"recorded" | "skipped"> {
	const opts = deps.history;
	if (!opts?.enabled) {
		return "skipped";
	}
	if (bytes.byteLength > MAX_VERSION_BYTES) {
		// shortcut: multi-part upload not implemented; large files unversioned
		deps.log?.(`history: ${path} >20 MiB, version skipped`);
		return "skipped";
	}
	const entry = deps.state.entries[pageId];
	const sha = await sha256Hex(bytes);
	if (sha === entry?.lastVersionSha) {
		deps.debug?.(`history ${path}: unchanged sha, version skipped`);
		return "skipped";
	}
	const now = deps.now?.() ?? Date.now();
	if (
		reason === "push" &&
		entry?.lastVersionAt !== undefined &&
		now - entry.lastVersionAt < opts.intervalMinutes * 60_000
	) {
		deps.debug?.(`history ${path}: within push interval, version skipped`);
		return "skipped";
	}

	const historyPageId = await ensureHistoryPage(deps, pageId);
	const name = basename(path);
	const plan = planUpload(name);
	const up = await deps.client.request<{ id: string }>(
		"POST",
		"/file_uploads",
		{ filename: plan.filename, content_type: plan.contentType },
	);
	const boundary = `----nhs${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
	const mp = buildMultipart(plan.filename, plan.contentType, bytes, boundary);
	await deps.client.requestRaw(
		"POST",
		`/file_uploads/${up.id}/send`,
		mp,
		`multipart/form-data; boundary=${boundary}`,
	);
	const caption = encodeCaption({
		v: 1,
		t: new Date(now).toISOString(),
		d: deps.deviceId.slice(0, 8),
		s: sha,
		z: bytes.byteLength,
		p: path,
		r: reason,
	});
	await deps.client.request("PATCH", `/blocks/${historyPageId}/children`, {
		position: { type: "start" },
		children: [
			{
				type: plan.blockType,
				[plan.blockType]: {
					type: "file_upload",
					file_upload: { id: up.id },
					caption: [{ type: "text", text: { content: caption } }],
				},
			},
		],
	});
	if (entry) {
		entry.lastVersionAt = now;
		entry.lastVersionSha = sha;
		entry.versionCount = (entry.versionCount ?? 0) + 1;
	}
	// retention listing only when over the cap or every 10th version —
	// the children listing costs 1-2 requests per record otherwise
	const vc = entry?.versionCount ?? 0;
	if (vc > opts.maxVersions || vc % 10 === 0) {
		await pruneHistory(deps, historyPageId, opts, now);
	}
	deps.debug?.(
		`history ${path}: recorded "${reason}" (${bytes.byteLength} B, ${sha.slice(0, 8)})`,
	);
	return "recorded";
}

/** recordVersion that never throws — logs + warns instead. */
export async function safeRecordVersion(
	deps: HistoryDeps,
	pageId: string,
	path: string,
	bytes: Uint8Array,
	reason: VersionReason,
	warn: (msg: string) => void,
): Promise<void> {
	try {
		await recordVersion(deps, pageId, path, bytes, reason);
	} catch (err) {
		const msg = `${path}: version write failed: ${
			err instanceof Error ? err.message : String(err)
		}`;
		deps.log?.(msg);
		warn(msg);
	}
}

/** Delete oldest blocks past maxVersions or older than retentionDays. */
async function pruneHistory(
	deps: HistoryDeps,
	historyPageId: string,
	opts: { maxVersions: number; retentionDays: number },
	now: number,
): Promise<void> {
	const blocks: Array<{ id: string; t: number | null }> = [];
	let cursor: string | undefined;
	// first listing page + at most one extra page keeps this bounded
	for (let page = 0; page < 2; page++) {
		const res = await deps.client.request<{
			results?: ChildBlock[];
			next_cursor?: string | null;
			has_more?: boolean;
		}>(
			"GET",
			`/blocks/${historyPageId}/children?page_size=${VERSION_PAGE_SIZE}` +
				(cursor ? `&start_cursor=${cursor}` : ""),
		);
		for (const b of res.results ?? []) {
			if (b.in_trash || !MEDIA_TYPES.has(b.type)) continue;
			const caption = parseCaption(captionOf(b));
			if (!caption) continue;
			const t = Date.parse(caption.t);
			blocks.push({ id: b.id, t: Number.isFinite(t) ? t : null });
		}
		cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
		if (!cursor) break;
	}
	const cutoff = now - opts.retentionDays * 86_400_000;
	const toDelete: string[] = [];
	blocks.forEach((b, i) => {
		if (i >= opts.maxVersions || (b.t !== null && b.t < cutoff)) {
			toDelete.push(b.id);
		}
	});
	for (const id of toDelete.slice(0, MAX_RETENTION_DELETES)) {
		await deps.client.request("DELETE", `/blocks/${id}`);
	}
	deps.debug?.(`history: pruned ${toDelete.length} old version block(s)`);
}
