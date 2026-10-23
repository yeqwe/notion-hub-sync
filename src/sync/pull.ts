import type { NotionClient } from "../notion/client";
import { notionToObsidian } from "../convert/notion-to-obsidian";
import type { LinkResolver } from "../convert/links";
import {
	decidePullContent,
	splitPageMarkdown,
	visibleHash,
} from "./toggle";
import { renderMatchesSource } from "./source-compare";
import { sha256Hex } from "./hashes";
import { basename, parentDir } from "./vault-io";
import { collisionFreePath, conflictPath, sanitizeTitle } from "./paths";
import { classifyPage, listChildPages } from "./tree";
import { safeRecordVersion } from "./history";
import type { SyncEntry } from "./state";
import type { SyncDeps, SyncReport } from "./deps";
import { newReport } from "./deps";

interface PageMdResponse {
	markdown?: string;
}

export interface Node {
	pageId: string;
	title: string;
	kind: "folder" | "note" | "file";
	parent: Node | null; // null = directly under root
	hasChildren: boolean;
	path: string; // filled during path mapping
	lastEdited?: string;
}

/** Sibling listings run this many at a time — the client's ~3 req/s
 * start-spacing still caps the total request rate. */
const WALK_POOL = 4;

export async function walkTree(
	deps: SyncDeps,
	pageId: string,
	parent: Node | null,
	out: Node[],
	onPage?: (node: Node) => void,
): Promise<void> {
	// Phase 1 fetches the raw subtree with a small worker pool over a
	// dynamic queue (children of any listed page join the queue). Phase 2
	// flattens it depth-first so `out` keeps the original deterministic
	// order; `onPage` fires at discovery so progress streams during the
	// walk, not after it.
	const pending: string[] = [pageId];
	let head = 0; // cursor — shift() would be O(n) per item
	const kids = new Map<string, Node[]>();
	let active = 0;
	let resolveDone!: () => void;
	let rejectDone!: (e: unknown) => void;
	const doneP = new Promise<void>((res, rej) => {
		resolveDone = res;
		rejectDone = rej;
	});

	const pump = (): void => {
		while (head < pending.length && active < WALK_POOL) {
			const pid = pending[head++]!;
			active++;
			void (async () => {
				const children = await listChildPages(deps.client, pid);
				const nodes = (
					await Promise.all(
						children.map(async (child) => {
							const kind = await classifyPage(
								deps.client,
								deps.state,
								child.id,
							);
							const hexId = child.id
								.replace(/-/g, "")
								.toLowerCase();
							if (
								kind === "config" ||
								kind === "history" ||
								kind === "journal"
							) {
								// settings (M5) + version-history container —
								// skip subtrees, but remember their ids.
								if (kind === "journal") {
									deps.state.journalId ??= hexId;
								} else if (kind === "history") {
									deps.state.historyRootId ??= hexId;
								} else {
									deps.state.configRootId ??= hexId;
								}
								return null;
							}
							const node: Node = {
								pageId: hexId,
								title: child.title,
								kind,
								parent: null,
								hasChildren: child.hasChildren,
								path: "",
								lastEdited: child.lastEdited,
							};
							onPage?.(node);
							return node;
						}),
					)
				).filter((n): n is Node => n !== null);
				kids.set(pid, nodes);
				for (const n of nodes) {
					if (n.hasChildren) pending.push(n.pageId);
				}
			})()
				.catch((e: unknown) => {
					// first listing failure fails the walk (as before)
					pending.length = head = 0;
					rejectDone(e);
				})
				.finally(() => {
					active--;
					pump();
				});
		}
		if (head === pending.length && active === 0) resolveDone();
	};
	pump();
	await doneP;

	const emit = (list: Node[] | undefined, par: Node | null): void => {
		for (const n of list ?? []) {
			n.parent = par;
			out.push(n);
			if (n.hasChildren) emit(kids.get(n.pageId), n);
		}
	};
	emit(kids.get(pageId), parent);
}

/** Directory that a node's children live in. */
function childDir(node: Node | null): string {
	if (node === null) return "";
	if (node.kind === "folder") return node.path === "" ? "" : `${node.path}/`;
	// child pages of a note/file land in a folder named after the parent
	const dir = parentDir(node.path);
	const stem = node.title ? sanitizeTitle(node.title) : basename(node.path);
	return `${dir === "" ? "" : dir + "/"}${stem}/`;
}

export function assignPaths(nodes: Node[]): void {
	const used = new Set<string>();
	for (const n of nodes) {
		const dir = childDir(n.parent);
		const name =
			n.kind === "note"
				? `${sanitizeTitle(n.title)}.md`
				: sanitizeTitle(n.title);
		n.path = collisionFreePath(dir, name, used);
	}
}

async function writeWithConflict(
	deps: SyncDeps,
	path: string,
	bytes: Uint8Array,
	isText: boolean,
	hasStateEntry: boolean,
	report: SyncReport,
): Promise<string> {
	if (!hasStateEntry && (await deps.vault.exists(path))) {
		const existing = new Uint8Array(await deps.vault.readBinary(path));
		if ((await sha256Hex(existing)) === (await sha256Hex(bytes))) {
			return path;
		}
		const conflict = conflictPath(
			path,
			deps.deviceId.slice(0, 8),
			new Date(),
		);
		report.failures.push(
			`${path}: local content kept as ${conflict}`,
		);
		report.failed++;
		if (isText) {
			await deps.vault.writeText(
				conflict,
				new TextDecoder().decode(existing),
			);
		} else {
			await deps.vault.writeBinary(
				conflict,
				existing.buffer as ArrayBuffer,
			);
		}
	}
	return path;
}

/** Snapshot the local bytes a pull is about to replace ("pre-pull"). */
async function preserveOverwritten(
	deps: SyncDeps,
	node: Node,
	incoming: Uint8Array,
	report: SyncReport,
): Promise<void> {
	if (!(await deps.vault.exists(node.path))) {
		return;
	}
	const existing = new Uint8Array(await deps.vault.readBinary(node.path));
	if ((await sha256Hex(existing)) === (await sha256Hex(incoming))) {
		return;
	}
	await safeRecordVersion(
		deps,
		node.pageId,
		node.path,
		existing,
		"pre-pull",
		(msg) => report.warnings.push(msg),
	);
}

export interface FetchedNote {
	bytes: Uint8Array;
	split: Awaited<ReturnType<typeof splitPageMarkdown>>;
	visSha: string;
	decision: ReturnType<typeof decidePullContent>;
}

export async function fetchNoteContent(
	deps: SyncDeps,
	pageId: string,
	links: LinkResolver,
): Promise<FetchedNote> {
	const res = await deps.client.request<PageMdResponse>(
		"GET",
		`/pages/${pageId}/markdown`,
	);
	const split = await splitPageMarkdown(res.markdown ?? "");
	const visSha = await visibleHash(split.visible);
	const decision = decidePullContent(split, visSha);
	let bytes: Uint8Array;
	if (decision.kind === "source") {
		bytes = decision.bytes;
	} else if (
		split.source?.bytes &&
		renderMatchesSource(split.source.bytes, split.visible, links)
	) {
		// Render drift, not a human edit: the recorded source is still
		// the lossless form of what's on the page — prefer it.
		bytes = split.source.bytes;
	} else {
		bytes = new TextEncoder().encode(
			notionToObsidian(split.visible, { links }),
		);
	}
	return { bytes, split, visSha, decision };
}

export interface FetchedFile {
	bytes: Uint8Array;
	mediaBlockId: string | null;
}

export async function fetchFileContent(
	deps: SyncDeps,
	pageId: string,
): Promise<FetchedFile> {
	const children = await deps.client.request<{
		results?: Array<{
			id: string;
			type: string;
			[key: string]: unknown;
		}>;
	}>("GET", `/blocks/${pageId}/children?page_size=100`);
	const media = (children.results ?? []).find((b) =>
		["image", "pdf", "audio", "video", "file"].includes(b.type),
	);
	const url = (
		media?.[media.type as keyof typeof media] as
			| { file?: { url?: string } }
			| undefined
	)?.file?.url;
	if (!media || !url) {
		// no media uploaded yet (e.g. page created by an interrupted push)
		return { bytes: new Uint8Array(), mediaBlockId: null };
	}
	const sizeHint = deps.state.entries[pageId]?.localSize;
	const data = new Uint8Array(
		await deps.client.download(url, { sizeHintBytes: sizeHint }),
	);
	return {
		bytes: data,
		mediaBlockId: media.id.replace(/-/g, "").toLowerCase(),
	};
}

async function pullNote(
	deps: SyncDeps,
	node: Node,
	links: LinkResolver,
	report: SyncReport,
): Promise<void> {
	const fetched = await fetchNoteContent(deps, node.pageId, links);
	const { bytes, split, visSha } = fetched;
	const entry = deps.state.entries[node.pageId];
	await preserveOverwritten(deps, node, bytes, report);
	const path = await writeWithConflict(
		deps,
		node.path,
		bytes,
		true,
		!!entry,
		report,
	);
	await deps.vault.writeText(path, new TextDecoder().decode(bytes));
	recordEntry(deps, node, path, "note", {
		srcSha: split.source?.srcSha,
		visSha,
		// localHash tracks the source version the page was last synced
		// against; written bytes may be the lossy conversion, but pushing
		// the original source file back should still skip.
		localHash: split.source?.srcSha ?? (await sha256Hex(bytes)),
	});
	report.updated++;
}

async function pullFile(
	deps: SyncDeps,
	node: Node,
	report: SyncReport,
): Promise<void> {
	const fetched = await fetchFileContent(deps, node.pageId);
	const data = fetched.bytes;
	const entry = deps.state.entries[node.pageId];
	await preserveOverwritten(deps, node, data, report);
	const path = await writeWithConflict(
		deps,
		node.path,
		data,
		false,
		!!entry,
		report,
	);
	await deps.vault.writeBinary(path, data.buffer as ArrayBuffer);
	const fileSha = await sha256Hex(data);
	recordEntry(deps, node, path, "file", {
		fileSha,
		localHash: fileSha,
		mediaBlockId: fetched.mediaBlockId ?? undefined,
	});
	report.updated++;
}

function recordEntry(
	deps: SyncDeps,
	node: Node,
	path: string,
	kind: SyncEntry["kind"],
	extra: Partial<SyncEntry>,
): void {
	deps.state.entries[node.pageId] = {
		...deps.state.entries[node.pageId],
		path,
		kind,
		notionTitle: node.title,
		parentId: node.parent?.pageId ?? deps.state.rootPageId,
		remoteEdited: node.lastEdited,
		...extra,
	} as SyncEntry;
}

export async function pullVault(deps: SyncDeps): Promise<SyncReport> {
	const report = newReport();
	const nodes: Node[] = [];
	await walkTree(deps, deps.state.rootPageId, null, nodes);
	assignPaths(nodes);

	const links: LinkResolver = {
		pageIdForTarget: () => null, // pull never needs target→pageId
		pathForPageId: (id) => {
			const hex = id.replace(/-/g, "").toLowerCase();
			const node = nodes.find((n) => n.pageId === hex);
			return node?.path ?? deps.state.entries[hex]?.path ?? null;
		},
	};

	// folders first
	for (const n of nodes.filter((x) => x.kind === "folder")) {
		try {
			await deps.vault.mkdirp(n.path);
			recordEntry(deps, n, n.path, "folder", {});
			report.updated++;
		} catch (err) {
			report.failed++;
			report.failures.push(
				`${n.path}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	// then notes and files
	let done = 0;
	const rest = nodes.filter((x) => x.kind !== "folder");
	for (const n of rest) {
		done++;
		deps.progress?.(done, rest.length, n.path);
		try {
			const dir = parentDir(n.path);
			if (dir !== "") {
				await deps.vault.mkdirp(dir);
			}
			if (n.kind === "note") {
				await pullNote(deps, n, links, report);
			} else {
				await pullFile(deps, n, report);
			}
		} catch (err) {
			report.failed++;
			report.failures.push(
				`${n.path}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	await deps.saveState();
	return report;
}
