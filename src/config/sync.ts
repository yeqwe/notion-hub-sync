// Config-dir sync round: local scan → remote eval → planConfig → apply.
// Config pages live flat under the ⚙️ system page, title = rel path,
// one media block each. Called from runSync after the main apply.

import type { NotionClient } from "../notion/client";
import { sha256Hex } from "../sync/hashes";
import { planUpload, uploadBytes } from "../sync/upload";
import { listChildPages } from "../sync/tree";
import { createPage } from "../sync/push";
import { findReservedPage, ensureReservedPage } from "../sync/reserved";
import type { SyncState } from "../sync/state";
import type { SyncDeps } from "../sync/deps";
import type { JournalOp } from "../engine/journal";
import type { ConfigIO } from "./config-io";
import {
	anyConfigEnabled,
	configFileAllowed,
	conflictCopyRel,
	descendAllowed,
	type ConfigSyncSettings,
} from "./filter";
import { planConfig, type ConfigBase } from "./plan";

export const CONFIG_ROOT_TITLE = "⚙️ Obsidian 设置 (notion-hub-sync)";
export const CONFIG_ROOT_ICON = "⚙️";
const MOBILE_SCAN_MIN_MS = 10 * 60_000;

export interface ConfigSyncDeps {
	client: NotionClient;
	state: SyncState;
	io: ConfigIO;
	settings: ConfigSyncSettings;
	/** manifest.id — own plugin dir is never synced. */
	selfId: string;
	deviceId: string;
	isMobile: boolean;
	now: () => number;
	log?: (msg: string) => void;
}

export interface ConfigSyncResult {
	journalOps: JournalOp[];
	/** at least one local config file was written/removed → suggest reload. */
	localWritten: boolean;
	/** local-only conflict copies written under configDir. */
	conflictCopies: string[];
}

const hex = (id: string): string => id.replace(/-/g, "").toLowerCase();

const CANONICAL_JSON_MAX_BYTES = 2 * 1024 * 1024;

/** Sorted-key JSON serialisation, or null when the text isn't a JSON object. */
export function canonicalJson(text: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const norm = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(norm);
		if (v !== null && typeof v === "object") {
			const obj = v as Record<string, unknown>;
			const out: Record<string, unknown> = {};
			for (const k of Object.keys(obj).sort()) out[k] = norm(obj[k]);
			return out;
		}
		return v;
	};
	return JSON.stringify(norm(parsed));
}

/** Content sha used for change detection.
 *
 * JSON files are hashed by a key-order-insensitive canonical form.
 * Obsidian re-serialises `app.json`, `appearance.json`, `core-plugins.json`
 * and `community-plugins.json` on every start (a long-standing upstream
 * complaint), so key order and whitespace drift by themselves. A plain
 * byte hash then reports "the user changed this file" on a device where
 * nothing was touched — and a false local change is exactly what turns the
 * other device's sync into a conflict copy.
 *
 * Text that isn't a JSON object (array, scalar, corrupt) falls back to the
 * byte hash: there the bytes really are the meaning.
 */
export async function contentSha(
	rel: string,
	bytes: Uint8Array,
): Promise<string> {
	if (
		rel.toLowerCase().endsWith(".json") &&
		bytes.length <= CANONICAL_JSON_MAX_BYTES
	) {
		const canonical = canonicalJson(new TextDecoder().decode(bytes));
		if (canonical !== null) {
			return sha256Hex(new TextEncoder().encode(canonical));
		}
	}
	return sha256Hex(bytes);
}

/** Find (or lazily record) the ⚙️ page; creates nothing (create on push). */
async function findConfigRoot(
	client: NotionClient,
	state: SyncState,
): Promise<string | null> {
	if (state.configRootId) return state.configRootId;
	const found = await findReservedPage(client, state, {
		title: CONFIG_ROOT_TITLE,
		icon: CONFIG_ROOT_ICON,
	});
	if (found) state.configRootId = found;
	return found;
}

async function uploadConfigContent(
	client: NotionClient,
	pageId: string,
	rel: string,
	bytes: Uint8Array,
): Promise<string | null> {
	const name = rel.split("/").pop()!;
	const plan = planUpload(name);
	const upId = await uploadBytes(
		client,
		plan.filename,
		plan.contentType,
		bytes,
	);
	const children = await client.request<{
		results?: Array<{ id: string; type: string }>;
	}>("GET", `/blocks/${pageId}/children?page_size=100`);
	for (const b of children.results ?? []) {
		if (["image", "pdf", "audio", "video", "file"].includes(b.type)) {
			await client.request("DELETE", `/blocks/${b.id}`);
		}
	}
	const appended = await client.request<{ results?: Array<{ id: string }> }>(
		"PATCH",
		`/blocks/${pageId}/children`,
		{
			children: [
				{
					type: plan.blockType,
					[plan.blockType]: {
						type: "file_upload",
						file_upload: { id: upId },
						caption: [{ type: "text", text: { content: name } }],
					},
				},
			],
		},
	);
	const bid = appended.results?.[0]?.id;
	return bid ? hex(bid) : null;
}

interface RemoteConfig {
	sha: string;
	pageId: string;
	bytes?: Uint8Array;
	mediaBlockId?: string | null;
}

/** Evaluate one config page → sha (+bytes when content changed).
 * `rel` is the config-relative path the page stands for — the content sha
 * is only key-order-insensitive for known JSON files, so it must be the
 * same path the local side and the base were hashed under. */
async function evalConfigPage(
	client: NotionClient,
	pageId: string,
	rel: string,
	baseSha: string | undefined,
	baseBlockId: string | undefined,
): Promise<{ sha: string; bytes?: Uint8Array; mediaBlockId: string | null } | null> {
	const children = await client.request<{
		results?: Array<{ id: string; type: string; [k: string]: unknown }>;
	}>("GET", `/blocks/${pageId}/children?page_size=100`);
	const media = (children.results ?? []).find((b) =>
		["image", "pdf", "audio", "video", "file"].includes(b.type),
	);
	const blockId = media ? hex(media.id) : null;
	if (blockId && blockId === baseBlockId && baseSha) {
		return { sha: baseSha, mediaBlockId: blockId };
	}
	const url = (
		media?.[media.type as keyof typeof media] as
			| { file?: { url?: string } }
			| undefined
	)?.file?.url;
	if (!url) return { sha: baseSha ?? "", mediaBlockId: blockId };
	const bytes = new Uint8Array(await client.download(url));
	return {
		sha: await contentSha(rel, bytes),
		bytes,
		mediaBlockId: blockId,
	};
}

export async function syncConfig(
	deps: ConfigSyncDeps,
	opts: { full: boolean; journalCandidateIds: Set<string> },
): Promise<ConfigSyncResult> {
	const out: ConfigSyncResult = {
		journalOps: [],
		localWritten: false,
		conflictCopies: [],
	};
	const { state, io, settings: cfg } = deps;
	if (!anyConfigEnabled(cfg)) return out;
	const now = deps.now();
	if (
		deps.isMobile &&
		state.lastConfigScan !== undefined &&
		now - state.lastConfigScan < MOBILE_SCAN_MIN_MS
	) {
		return out;
	}
	state.lastConfigScan = now;
	state.config = state.config ?? {};

	// ---- local scan ----
	const local: Record<string, { exists: true; sha: string }> = {};
	const statOf = new Map<string, { size: number; mtime: number }>();
	const walk = async (dir: string): Promise<void> => {
		const listing = await io.list(dir);
		for (const name of listing.files) {
			const rel = dir === "" ? name : `${dir}/${name}`;
			if (!configFileAllowed(rel, cfg, deps.selfId)) continue;
			const st = await io.stat(rel);
			if (!st) continue;
			statOf.set(rel, st);
			// Always re-hash the bytes. An mtime+size short-circuit looks free
			// but is wrong in the exact case that matters here: an edit that
			// keeps the byte count identical and lands in the same mtime tick
			// (iOS reports a coarse mtime) is invisible, so a real setting
			// change is never pushed. Config files are few and small 鈥?local
			// IO, not requests 鈥?so reading them is the cheap part.
			const sha = await contentSha(
				rel,
				new Uint8Array(await io.readBinary(rel)),
			);
			local[rel] = { exists: true, sha };
		}
		for (const name of listing.folders) {
			const rel = dir === "" ? name : `${dir}/${name}`;
			if (descendAllowed(rel, cfg, deps.selfId)) await walk(rel);
		}
	};
	await walk("");

	// ---- remote ----
	const remote: Record<
		string,
		{ sha: string; pageId: string } | { deleted: true }
	> = {};
	const remoteBytes = new Map<string, Uint8Array>();
	const remoteBlock = new Map<string, string | null>();
	// findConfigRoot lists root children when configRootId is unknown —
	// skip it entirely on rounds where nothing could reference config
	// (no base entries, no local files, no journal candidates, no audit).
	const needsRemote =
		opts.full ||
		Object.keys(state.config).length > 0 ||
		Object.keys(local).length > 0 ||
		opts.journalCandidateIds.size > 0;
	const configRoot = needsRemote
		? await findConfigRoot(deps.client, state)
		: null;
	const audit =
		opts.full || state.configRootId === undefined || !configRoot;
	const pageByRel = new Map<string, string>();
	for (const [rel, b] of Object.entries(state.config)) {
		pageByRel.set(rel, b.pageId);
	}
	const evalIds = new Set<string>();
	if (configRoot) {
		if (audit) {
			for (const child of await listChildPages(
				deps.client,
				configRoot,
			)) {
				evalIds.add(hex(child.id));
			}
		}
		for (const id of opts.journalCandidateIds) evalIds.add(id);
	}
	for (const id of evalIds) {
		try {
			const page = await deps.client.request<{
				in_trash?: boolean;
				parent?: { page_id?: string };
				properties?: {
					title?: { title?: Array<{ plain_text?: string }> };
				};
			}>("GET", `/pages/${id}`);
			if (page.in_trash) {
				const rel = [...pageByRel.entries()].find(
					([, v]) => v === id,
				)?.[0];
				if (rel) remote[rel] = { deleted: true };
				continue;
			}
			if (configRoot && hex(page.parent?.page_id ?? "") !== configRoot) {
				continue; // not a config page
			}
			const rel =
				page.properties?.title?.title
					?.map((t) => t.plain_text ?? "")
					.join("") ?? "";
			if (!rel) continue;
			const b = state.config[rel];
			const r = await evalConfigPage(
				deps.client,
				id,
				rel,
				b?.sha,
				b?.mediaBlockId,
			);
			if (!r) continue;
			remote[rel] = { sha: r.sha, pageId: id };
			if (r.bytes) remoteBytes.set(rel, r.bytes);
			remoteBlock.set(rel, r.mediaBlockId);
		} catch {
			// page gone or unreadable — treat as deleted when known
			const rel = [...pageByRel.entries()].find(
				([, v]) => v === id,
			)?.[0];
			if (rel) remote[rel] = { deleted: true };
		}
	}
	// audit: base entries not seen → remote deleted
	if (audit && configRoot) {
		for (const [rel, b] of Object.entries(state.config)) {
			if (!evalIds.has(b.pageId) && remote[rel] === undefined) {
				remote[rel] = { deleted: true };
			}
		}
	}

	// ---- plan + apply ----
	const actions = planConfig(state.config, local, remote);
	const syncDepsLike: SyncDeps = {
		vault: null as unknown as SyncDeps["vault"],
		client: deps.client,
		state,
		saveState: async () => {},
		resolvePath: () => null,
		deviceId: deps.deviceId,
	};
	const ensureRoot = async (): Promise<string> => {
		const found = await findConfigRoot(deps.client, state);
		if (found) return found;
		return ensureReservedPage(
			deps,
			{ title: CONFIG_ROOT_TITLE, icon: CONFIG_ROOT_ICON },
			state.configRootId,
			(id) => {
				state.configRootId = id;
			},
		);
	};
	const setBase = async (rel: string, pageId: string): Promise<void> => {
		const bytes = new Uint8Array(await io.readBinary(rel));
		const st = await io.stat(rel);
		state.config![rel] = {
			pageId,
			sha: await contentSha(rel, bytes),
			localMtime: st?.mtime,
			localSize: st?.size,
			mediaBlockId: remoteBlock.get(rel) ?? undefined,
		};
	};

	for (const a of actions) {
		try {
			switch (a.type) {
				case "pushCreate": {
					const root = await ensureRoot();
					const rawId = await createPage(
						syncDepsLike,
						root,
						a.rel,
						"📎",
					);
					const pageId = hex(rawId.id);
					const bytes = new Uint8Array(
						await io.readBinary(a.rel),
					);
					const blockId = await uploadConfigContent(
						deps.client,
						pageId,
						a.rel,
						bytes,
					);
					const st = await io.stat(a.rel);
					state.config[a.rel] = {
						pageId,
						sha: await contentSha(a.rel, bytes),
						mediaBlockId: blockId ?? undefined,
						localMtime: st?.mtime,
						localSize: st?.size,
					};
					out.journalOps.push({ o: "n", id: pageId });
					break;
				}
				case "pushUpdate": {
					const bytes = new Uint8Array(
						await io.readBinary(a.rel),
					);
					const blockId = await uploadConfigContent(
						deps.client,
						a.pageId,
						a.rel,
						bytes,
					);
					const b = state.config[a.rel]!;
					b.sha = await contentSha(a.rel, bytes);
					b.mediaBlockId = blockId ?? undefined;
					const st = await io.stat(a.rel);
					b.localMtime = st?.mtime;
					b.localSize = st?.size;
					out.journalOps.push({ o: "c", id: a.pageId, s: b.sha });
					break;
				}
				case "pullWrite":
				case "conflictWrite": {
					const bytes =
						remoteBytes.get(a.rel) ??
						(await fetchConfigBytes(deps.client, a.pageId));
					if (a.type === "conflictWrite") {
						const localBytes = new Uint8Array(
							await io.readBinary(a.rel),
						);
						// Never write the copy into configDir itself: it would look
						// like an ordinary `*.json` setting to Obsidian and to the
						// next round. The plugin dir is never synced.
						const copy = conflictCopyRel(
							a.rel,
							deps.selfId,
							deps.deviceId,
							new Date(now),
						);
						await io.writeBinary(
							copy,
							localBytes.buffer as ArrayBuffer,
						);
						out.conflictCopies.push(copy);
					}
					await io.writeBinary(
						a.rel,
						bytes.buffer as ArrayBuffer,
					);
					const st = await io.stat(a.rel);
					state.config[a.rel] = {
						pageId: a.pageId,
						sha: (remote[a.rel] as { sha: string }).sha,
						mediaBlockId: remoteBlock.get(a.rel) ?? undefined,
						localMtime: st?.mtime,
						localSize: st?.size,
					};
					out.localWritten = true;
					break;
				}
				case "trashRemote": {
					await deps.client.request("PATCH", `/pages/${a.pageId}`, {
						in_trash: true,
					});
					delete state.config[a.rel];
					out.journalOps.push({ o: "t", id: a.pageId });
					break;
				}
				case "trashLocal": {
					await io.trash(a.rel);
					delete state.config[a.rel];
					out.localWritten = true;
					break;
				}
				case "updateBase": {
					const r = remote[a.rel];
					if (r && !("deleted" in r)) {
						const b = state.config[a.rel];
						if (b) {
							const st = statOf.get(a.rel);
							b.localMtime = st?.mtime;
							b.localSize = st?.size;
							b.pageId = r.pageId;
							b.mediaBlockId =
								remoteBlock.get(a.rel) ?? b.mediaBlockId;
						} else {
							await setBase(a.rel, r.pageId);
						}
					}
					break;
				}
				case "dropBase": {
					delete state.config[a.rel];
					break;
				}
			}
		} catch (err) {
			deps.log?.(`config ${a.type} ${a.rel}: ${String(err)}`);
		}
	}
	return out;
}

async function fetchConfigBytes(
	client: NotionClient,
	pageId: string,
): Promise<Uint8Array> {
	const children = await client.request<{
		results?: Array<{ id: string; type: string; [k: string]: unknown }>;
	}>("GET", `/blocks/${pageId}/children?page_size=100`);
	const media = (children.results ?? []).find((b) =>
		["image", "pdf", "audio", "video", "file"].includes(b.type),
	);
	const url = (
		media?.[media.type as keyof typeof media] as
			| { file?: { url?: string } }
			| undefined
	)?.file?.url;
	if (!url) throw new Error(`config page ${pageId} has no media`);
	return new Uint8Array(await client.download(url));
}

export type { ConfigBase };
