import { NotionApiError, type NotionClient } from "../notion/client";
import { obsidianToNotion } from "../convert/obsidian-to-notion";
import { isDroppedLinkTarget, type LinkResolver } from "../convert/links";
import {
	buildSourceToggle,
	splitPageMarkdown,
	summaryLine,
	visibleHash,
	VIS_PLACEHOLDER,
	SOURCE_TOGGLE_MAX_BYTES,
} from "./toggle";
import { sha256Hex } from "./hashes";
import { basename, isSyncablePath, parentDir, type VaultFile } from "./vault-io";
import { entryByPath, type SyncEntry } from "./state";
import { planUpload, uploadBytes } from "./upload";
import { safeRecordVersion } from "./history";
import type { SyncDeps, SyncReport } from "./deps";
import { newReport } from "./deps";

const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024;

/** Human size for block reasons / log lines. */
function formatMb(bytes: number): string {
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

interface PageMdResponse {
	object?: string;
	markdown?: string;
	last_edited_time?: string;
}

function hexOf(url: string): string | null {
	return url.match(/[0-9a-fA-F]{32}/)?.[0]?.toLowerCase() ?? null;
}

/** Distinct non-http(s) link targets in `text`, capped so a note with a
 * thousand `obsidian://` links produces one readable warning. */
function droppedLinkTargets(text: string): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	// inline `[text](target)` and images alike; both lose the target.
	for (const m of text.matchAll(/!?\[[^\]\n]*\]\(([^)\s]*)/g)) {
		const url = (m[1] as string) ?? "";
		if (!isDroppedLinkTarget(url) || seen.has(url)) continue;
		seen.add(url);
		out.push(url.length > 40 ? `${url.slice(0, 37)}…` : url);
		if (out.length >= 5) break;
	}
	return out;
}

export function makeLinks(deps: SyncDeps): LinkResolver {
	return {
		pageIdForTarget: (target, sourcePath) => {
			const p = deps.resolvePath(target, sourcePath);
			if (!p) return null;
			return entryByPath(deps.state, p)?.pageId ?? null;
		},
		pathForPageId: (id) => {
			const hex = id.replace(/-/g, "").toLowerCase();
			return deps.state.entries[hex]?.path ?? null;
		},
	};
}

export async function createPage(
	deps: SyncDeps,
	parentId: string,
	title: string,
	icon?: string,
): Promise<{ id: string; lastEdited?: string }> {
	const body: Record<string, unknown> = {
		parent: { page_id: parentId },
		properties: { title: { title: [{ text: { content: title } }] } },
	};
	if (icon) {
		body.icon = { type: "emoji", emoji: icon };
	}
	const res = await deps.client.request<{
		id: string;
		last_edited_time?: string;
	}>("POST", "/pages", body);
	return { id: res.id, lastEdited: res.last_edited_time };
}

export function titleFor(path: string, kind: string): string {
	const base = basename(path);
	if (kind === "note" && base.toLowerCase().endsWith(".md")) {
		return base.slice(0, -3);
	}
	return base;
}

async function ensurePage(
	deps: SyncDeps,
	path: string,
	kind: SyncEntry["kind"],
	parentId: string,
	icon: string | undefined,
	report: SyncReport,
): Promise<string | null> {
	const found = entryByPath(deps.state, path);
	if (found) {
		return found.pageId;
	}
	const created = await createPage(
		deps,
		parentId,
		titleFor(path, kind),
		icon,
	);
	const hex = hexOf(created.id) ?? created.id.replace(/-/g, "");
	deps.state.entries[hex] = {
		path,
		kind,
		notionTitle: titleFor(path, kind),
		parentId,
		remoteEdited: created.lastEdited,
	};
	report.created++;
	await deps.saveState();
	return hex;
}

async function maybeRename(
	deps: SyncDeps,
	pageId: string,
	path: string,
	kind: SyncEntry["kind"],
	report: SyncReport,
): Promise<void> {
	const entry = deps.state.entries[pageId];
	const want = titleFor(path, kind);
	if (entry && entry.notionTitle !== want) {
		await deps.client.request("PATCH", `/pages/${pageId}`, {
			properties: { title: { title: [{ text: { content: want } }] } },
		});
		entry.notionTitle = want;
		report.updated++;
	}
}

async function noteChildPageLines(
	deps: SyncDeps,
	pageId: string,
): Promise<string[]> {
	const res = await deps.client.request<PageMdResponse>(
		"GET",
		`/pages/${pageId}/markdown`,
	);
	const split = await splitPageMarkdown(res.markdown ?? "");
	return split.childPageLines;
}

export async function pushNoteContent(
	deps: SyncDeps,
	pageId: string,
	file: VaultFile,
	links: LinkResolver,
	report: SyncReport,
	opts?: { recordHistory?: boolean },
): Promise<void> {
	const entry = deps.state.entries[pageId];
	const buf = new Uint8Array(await deps.vault.readBinary(file.path));
	const srcSha = await sha256Hex(buf);
	if (entry?.localHash === srcSha && entry.srcSha === srcSha) {
		report.skipped++;
		deps.debug?.(`push note ${file.path}: unchanged, skipped`);
		return;
	}
	deps.debug?.(`push note ${file.path} (${srcSha.slice(0, 8)})`);
	const text = new TextDecoder().decode(buf);
	const visible = obsidianToNotion(text, {
		links,
		sourcePath: file.path,
	});
	// Notion silently strips link targets it does not accept (obsidian://,
	// file://, empty). The push succeeds, so without this the loss is only
	// discovered on the other device — days later, with no way to tell which
	// round did it. The source toggle still holds the original bytes, so the
	// link is recoverable; say so instead of leaving it silent.
	const dropped = droppedLinkTargets(text);
	if (dropped.length > 0) {
		report.warnings.push(
			`${file.path}: ${dropped.length} link target(s) Notion will not store ` +
				`(${dropped.slice(0, 3).join(", ")}${dropped.length > 3 ? ", …" : ""}) — ` +
				`the link text is kept, the target is not`,
		);
		deps.debug?.(
			`push note ${file.path}: dropped link targets ${JSON.stringify(dropped)}`,
		);
	}
	const toggle = buildSourceToggle(srcSha, VIS_PLACEHOLDER, buf);
	if (toggle === null) {
		deps.log?.(
			`warning: ${file.path} > ${SOURCE_TOGGLE_MAX_BYTES} bytes; source toggle omitted (lossy)`,
		);
	}
	let body =
		toggle === null ? visible : `${visible}\n${toggle}`;

	const patch = (newStr: string) =>
		deps.client.request<PageMdResponse>(
			"PATCH",
			`/pages/${pageId}/markdown`,
			{
				type: "replace_content",
				replace_content: { new_str: newStr },
			},
		);

	let resp: PageMdResponse;
	let lastEdited: string | undefined;
	try {
		resp = await patch(body);
	} catch (err) {
		if (
			err instanceof NotionApiError &&
			err.status === 400 &&
			/child page|would delete/i.test(err.message)
		) {
			const childLines = await noteChildPageLines(deps, pageId);
			body = `${body}\n${childLines.join("\n")}`;
			resp = await patch(body);
		} else {
			throw err;
		}
	}

	// step 2: fix the visible: hash via update_content. The hash must match
	// what Notion actually stored, which is only knowable from the response
	// — a pre-computed value would disagree after Notion normalizes the
	// markdown and silently push the other device onto the lossy path.
	lastEdited = resp.last_edited_time;
	const respMd = resp.markdown ?? "";
	const split = await splitPageMarkdown(respMd);
	let visSha = await visibleHash(split.visible);
	const oldSummary = summaryLine(srcSha, VIS_PLACEHOLDER);
	if (respMd.includes(oldSummary)) {
		let upd = await deps.client.request<PageMdResponse>(
			"PATCH",
			`/pages/${pageId}/markdown`,
			{
				type: "update_content",
				update_content: {
					content_updates: [
						{ old_str: oldSummary, new_str: summaryLine(srcSha, visSha) },
					],
				},
			},
		);
		// Notion may normalize further; the update_content response is the
		// final stored form — write the corrected hash when it drifted.
		const updMd = upd.markdown ?? "";
		const updSha = updMd
			? await visibleHash((await splitPageMarkdown(updMd)).visible)
			: visSha;
		if (updSha !== visSha && updMd.includes(summaryLine(srcSha, visSha))) {
			upd = await deps.client.request<PageMdResponse>(
				"PATCH",
				`/pages/${pageId}/markdown`,
				{
					type: "update_content",
					update_content: {
						content_updates: [
							{
								old_str: summaryLine(srcSha, visSha),
								new_str: summaryLine(srcSha, updSha),
							},
						],
					},
				},
			);
			visSha = updSha;
		}
		if (!(upd.markdown ?? "").includes(summaryLine(srcSha, visSha))) {
			deps.log?.(
				`warning: visible-hash update not reflected for ${file.path}`,
			);
		}
		lastEdited = upd.last_edited_time ?? lastEdited;
	} else {
		deps.log?.(
			`warning: placeholder summary not found for ${file.path}`,
		);
	}

	if (entry) {
		entry.srcSha = srcSha;
		entry.visSha = visSha;
		entry.localHash = srcSha;
		// A push replaces the remote with LOCAL content, so the sha it
		// supersedes is deliberately NOT added to `shaHistory`: going back to
		// content this device itself wrote is a deliberate revert, and
		// blocking it would make "undo my own edit" silently stop working.
		// Anything in the history is unreachable by definition now, so drop
		// it — leaving it would let a much later rollback to a long-gone
		// version be mistaken for a stale copy.
		entry.shaHistory = undefined;
		// last_edited_time of the final PATCH — keeps the search-hit
		// gate (entry.remoteEdited === result.last_edited_time) from
		// re-evaluating a page we just wrote ourselves.
		if (lastEdited) entry.remoteEdited = lastEdited;
	}
	report.updated++;
	// Initial uploads (pushNew) skip history: the content lives in the page.
	if (opts?.recordHistory !== false) {
		await safeRecordVersion(deps, pageId, file.path, buf, "push", (msg) =>
			report.warnings.push(msg),
		);
	}
}

const MEDIA_TYPES = new Set(["image", "pdf", "audio", "video", "file"]);

export async function pushFileContent(
	deps: SyncDeps,
	pageId: string,
	file: VaultFile,
	report: SyncReport,
	opts?: { recordHistory?: boolean },
): Promise<void> {
	const entry = deps.state.entries[pageId];
	const buf = new Uint8Array(await deps.vault.readBinary(file.path));
	const maxMB =
		(deps as { engine?: { maxFileSizeMB?: number } }).engine
			?.maxFileSizeMB ?? 0;
	const limit =
		maxMB > 0 ? maxMB * 1024 * 1024 : DEFAULT_MAX_FILE_BYTES;
	if (buf.byteLength > limit) {
		report.skipped++;
		report.blocked.push({
			path: file.path,
			reason: "oversized",
			detail: `${formatMb(buf.byteLength)} > ${formatMb(limit)}`,
		});
		deps.log?.(
			`blocked: ${file.path} is ${formatMb(buf.byteLength)} (limit ${formatMb(limit)})`,
		);
		return;
	}
	const fileSha = await sha256Hex(buf);
	if (entry?.fileSha === fileSha) {
		report.skipped++;
		deps.debug?.(`push file ${file.path}: unchanged, skipped`);
		return;
	}
	deps.debug?.(
		`push file ${file.path} (${formatMb(buf.byteLength)}, ${fileSha.slice(0, 8)})`,
	);
	const name = basename(file.path);
	const plan = planUpload(name);

	const upId = await uploadBytes(
		deps.client,
		plan.filename,
		plan.contentType,
		buf,
		(p, n) =>
			deps.event?.({
				t: "upload",
				path: file.path,
				part: p,
				parts: n,
				bytes: buf.byteLength,
			}),
	);

	// remove existing media blocks before attaching the new one
	const children = await deps.client.request<{
		results?: Array<{ id: string; type: string }>;
	}>("GET", `/blocks/${pageId}/children?page_size=100`);
	for (const b of children.results ?? []) {
		if (MEDIA_TYPES.has(b.type)) {
			await deps.client.request("DELETE", `/blocks/${b.id}`);
		}
	}

	const t = plan.blockType;
	const appended = await deps.client.request<{
		results?: Array<{ id: string }>;
	}>("PATCH", `/blocks/${pageId}/children`, {
		children: [
			{
				type: t,
				[t]: {
					type: "file_upload",
					file_upload: { id: upId },
					// exact content id in the caption: a later eval can read
					// the sha without downloading the file
					caption: [
						{ type: "text", text: { content: name } },
						{
							type: "text",
							text: { content: ` · sha256:${fileSha}` },
							annotations: { color: "gray" },
						},
					],
				},
			},
		],
	});
	if (entry) {
		entry.fileSha = fileSha;
		entry.localHash = fileSha;
		// Same reasoning as pushNoteContent: a pushed version is authored
		// here, so nothing older is a "stale copy" worth recognising.
		entry.shaHistory = undefined;
		const blockId = appended.results?.[0]?.id;
		if (blockId) {
			entry.mediaBlockId = blockId.replace(/-/g, "").toLowerCase();
		}
	}
	report.updated++;
	if (opts?.recordHistory !== false) {
		await safeRecordVersion(deps, pageId, file.path, buf, "push", (msg) =>
			report.warnings.push(msg),
		);
	}
}

export async function pushVault(deps: SyncDeps): Promise<SyncReport> {
	const report = newReport();
	const links = makeLinks(deps);
	const { files, folders } = await deps.vault.list();
	const syncable = files.filter((f) => isSyncablePath(f.path));
	const folderSet = new Set<string>();
	for (const f of syncable) {
		let d = parentDir(f.path);
		while (d !== "") {
			folderSet.add(d);
			d = parentDir(d);
		}
	}
	for (const f of folders) {
		if (isSyncablePath(f) && f !== "") folderSet.add(f);
	}
	deps.log?.(
		`push: ${syncable.length} file(s) in ${folderSet.size} folder(s)`,
	);

	// phase 0: folders top-down
	const sortedFolders = [...folderSet].sort(
		(a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
	);
	const folderId = new Map<string, string>();
	for (const folder of sortedFolders) {
		try {
			const parentPath = parentDir(folder);
			const parent =
				parentPath === ""
					? deps.state.rootPageId
					: folderId.get(parentPath);
			if (!parent) {
				throw new Error(`missing parent page for ${folder}`);
			}
			const id = await ensurePage(
				deps,
				folder,
				"folder",
				parent,
				"📁",
				report,
			);
			if (id) folderId.set(folder, id);
			await maybeRename(deps, id!, folder, "folder", report);
		} catch (err) {
			report.failed++;
			report.failures.push(
				`${folder}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// phase 1: create missing note/file pages
	const pageIdOf = new Map<string, string>();
	for (const file of syncable) {
		const kind: SyncEntry["kind"] = file.path.toLowerCase().endsWith(".md")
			? "note"
			: "file";
		try {
			const dir = parentDir(file.path);
			const parent =
				dir === "" ? deps.state.rootPageId : folderId.get(dir);
			if (!parent) {
				throw new Error(`missing parent page for ${file.path}`);
			}
			const id = await ensurePage(
				deps,
				file.path,
				kind,
				parent,
				kind === "file" ? "📎" : undefined,
				report,
			);
			if (id) pageIdOf.set(file.path, id);
			await maybeRename(deps, id!, file.path, kind, report);
		} catch (err) {
			report.failed++;
			report.failures.push(
				`${file.path}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	// phase 2: contents
	let done = 0;
	for (const file of syncable) {
		const pageId = pageIdOf.get(file.path);
		if (!pageId) {
			report.failed++;
			continue;
		}
		done++;
		deps.progress?.(done, syncable.length, file.path);
		try {
			if (file.path.toLowerCase().endsWith(".md")) {
				await pushNoteContent(deps, pageId, file, links, report);
			} else {
				await pushFileContent(deps, pageId, file, report);
			}
		} catch (err) {
			report.failed++;
			report.failures.push(
				`${file.path}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	await deps.saveState();
	deps.log?.(
		`push done: created=${report.created} updated=${report.updated} ` +
			`skipped=${report.skipped} failed=${report.failed} blocked=${report.blocked.length}`,
	);
	return report;
}
