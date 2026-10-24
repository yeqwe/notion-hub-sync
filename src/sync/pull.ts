import type { NotionClient } from "../notion/client";
import type { LinkResolver } from "../convert/links";
import {
	decidePullContent,
	splitPageMarkdown,
	visibleHash,
} from "./toggle";
import { pullTextFromSplit } from "./source-compare";
import { sha256Hex } from "./hashes";
import { writeTextVerified, writeVerified } from "./vault-io";
import { basename, parentDir } from "./vault-io";
import {
	collisionFreePath,
	conflictPath,
	safeFileName,
	sanitizeTitle,
} from "./paths";
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
		// `safeFileName` only here: this is where a NEW path is minted for the
		// disk. Applying it inside `sanitizeTitle` would also rewrite titles
		// derived from existing entries, which makes a page stop matching its
		// own base record (→ a rename every round).
		const base =
			n.kind === "note"
				? `${sanitizeTitle(n.title)}.md`
				: sanitizeTitle(n.title);
		const name = safeFileName(base);
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

/** Which branch a pull took — the only thing that explains a surprise
 * "this note looks different after syncing" report. */
function decisionKind(f: FetchedNote): string {
	return f.decision.kind === "source"
		? "lossless source"
		: "visible render";
}

/** Ceiling for one downloaded note's raw markdown. Not a Notion limit — a
 * "this is not what you think it is" guard: a page whose markdown endpoint
 * returns hundreds of megabytes is a runaway render (nested embeds, an
 * exported database that got flattened) and pulling it would freeze the
 * editor before the user can even see it. */
const NOTE_MAX_BYTES = 32 * 1024 * 1024;

/** Exposed so the guard's threshold can be asserted without allocating it. */
export const NOTE_MAX_BYTES_FOR_TEST = NOTE_MAX_BYTES;

export async function fetchNoteContent(
	deps: SyncDeps,
	pageId: string,
	links: LinkResolver,
): Promise<FetchedNote> {
	const res = await deps.client.request<PageMdResponse>(
		"GET",
		`/pages/${pageId}/markdown`,
	);
	const raw = res.markdown ?? "";
	// Checked on the decoded string (that is the only size the API gives us)
	// before any of the expensive parsing below runs.
	if (raw.length > NOTE_MAX_BYTES) {
		throw new RemoteTooLargeError(pageId, raw.length, NOTE_MAX_BYTES);
	}
	const split = await splitPageMarkdown(raw);
	const visSha = await visibleHash(split.visible);
	const decision = decidePullContent(split, visSha);
	const bytes = pullTextFromSplit(split, visSha, links);
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
	// Refuse before the download starts. Notion reports the size on the block;
	// a round that pulled a 2 GB attachment just to notice it is over the
	// limit has already spent the bandwidth (and, on mobile, the memory).
	const maxMB = (deps as { engine?: { maxFileSizeMB?: number } }).engine
		?.maxFileSizeMB;
	const limit = maxMB && maxMB > 0 ? maxMB * 1024 * 1024 : 200 * 1024 * 1024;
	const declared = blockSize(media);
	if (declared !== null && declared > limit) {
		throw new RemoteTooLargeError(pageId, declared, limit);
	}
	const data = new Uint8Array(
		await deps.client.download(url, { sizeHintBytes: sizeHint }),
	);
	// The declared size can lie (or be absent); check the bytes too, and let
	// the caller turn an oversized pull into a `blocked` entry rather than a
	// silent truncation.
	if (data.byteLength > limit) {
		throw new RemoteTooLargeError(pageId, data.byteLength, limit);
	}
	return {
		bytes: data,
		mediaBlockId: media.id.replace(/-/g, "").toLowerCase(),
	};
}

/** Remote content above the configured limit: not downloaded, not deleted. */
export class RemoteTooLargeError extends Error {
	constructor(
		readonly pageId: string,
		readonly bytes: number,
		readonly limit: number,
	) {
		super(
			`remote content is ${(bytes / 1024 / 1024).toFixed(1)} MB, above the ${(
				limit / 1024 / 1024
			).toFixed(0)} MB limit`,
		);
		this.name = "RemoteTooLargeError";
	}
}

/** `size` reported on a media block, in bytes; null when the block has none.
 * Notion puts it under the block's own type key (`file.size` etc.). */function blockSize(block: Record<string, unknown>): number | null {
	const payload = block[block.type as string] as
		| { size?: unknown }
		| undefined;
	const raw = payload?.size;
	return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
		? raw
		: null;
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
	deps.debug?.(
		`pull note ${node.path}: ${bytes.byteLength} B from ${decisionKind(fetched)}`,
	);
	await preserveOverwritten(deps, node, bytes, report);
	const path = await writeWithConflict(
		deps,
		node.path,
		bytes,
		true,
		!!entry,
		report,
	);
	// Verified: the base records `localHash` below, and a truncated write
	// would make that record permanently wrong (next round: "local == base"
	// → never repaired).
	const text = new TextDecoder().decode(bytes);
	await writeTextVerified(deps.vault, path, text, await sha256Hex(bytes));
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
	deps.debug?.(`pull file ${node.path}: ${data.byteLength} B`);
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
	const fileSha = await sha256Hex(data);
	await writeVerified(deps.vault, path, data, fileSha);
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
	deps.log?.(
		`pull: walked ${nodes.length} page(s) ` +
			`(${nodes.filter((n) => n.kind === "folder").length} folder, ` +
			`${nodes.filter((n) => n.kind === "note").length} note, ` +
			`${nodes.filter((n) => n.kind === "file").length} file)`,
	);

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
	deps.log?.(
		`pull done: updated=${report.updated} failed=${report.failed} ` +
			`warnings=${report.warnings.length}`,
	);
	return report;
}
