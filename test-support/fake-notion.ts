// In-memory Notion behind the RequestFn interface — implements exactly the
// endpoints the sync engine uses. last_edited_time is minute-rounded and
// only bumped by the human* helpers, mirroring the observed API quirk.

import type { HttpRequest, HttpResponse } from "../src/notion/client";

interface FakePage {
	id: string;
	parentId: string;
	title: string;
	icon: string | null;
	inTrash: boolean;
	markdown: string;
	lastEdited: number;
	createdTime: number;
}

interface FakeBlock {
	id: string;
	parentId: string;
	type: string;
	data: Record<string, unknown>;
	inTrash: boolean;
	createdTime: number;
}

interface FakeUpload {
	id: string;
	filename: string;
	contentType: string;
	mode: "single_part" | "multi_part";
	bytes: Uint8Array | null;
	parts: Map<number, Uint8Array>;
}

const BASE = "https://api.notion.com/v1";
export const FILES_BASE = "https://files.local/";

const norm = (id: string): string => id.replace(/-/g, "").toLowerCase();

function indexOfBytes(hay: Uint8Array, b: number, from = 0): number {
	for (let i = from; i < hay.length; i++) if (hay[i] === b) return i;
	return -1;
}

function indexOfSeq(hay: Uint8Array, seq: number[]): number {
	outer: for (let i = 0; i + seq.length <= hay.length; i++) {
		for (let j = 0; j < seq.length; j++) {
			if (hay[i + j] !== seq[j]) continue outer;
		}
		return i;
	}
	return -1;
}

function splitOnBytes(hay: Uint8Array, sep: Uint8Array): Uint8Array[] {
	const out: Uint8Array[] = [];
	let pos = 0;
	while (true) {
		const idx = indexOfSeq(hay.slice(pos), [...sep]);
		if (idx < 0) {
			out.push(hay.slice(pos));
			return out;
		}
		out.push(hay.slice(pos, pos + idx));
		pos += idx + sep.length;
	}
}

let seq = 0;
const newId = (): string =>
	(++seq).toString(16).padStart(8, "0") +
	"0000000040008000" +
	Math.floor(Math.random() * 0xffffffff)
		.toString(16)
		.padStart(8, "0");

export class FakeNotion {
	pages = new Map<string, FakePage>();
	blocks = new Map<string, FakeBlock>();
	uploads = new Map<string, FakeUpload>();
	now = Date.UTC(2026, 0, 1, 12, 0, 0);
	/** every request (method + path, url stripped) — for assertions. */
	reqLog: Array<{ method: string; path: string }> = [];
	/** POST /search request bodies in order — lets tests assert the sort. */
	searchRequests: Array<Record<string, unknown>> = [];
	private failures: Array<{ method?: string; path?: RegExp }> = [];
	/** human bump times that differ per page */
	private humanClock = 0;
	/** page ids whose next GET /markdown returns driftFn(rendered) once —
	 * simulates Notion re-normalizing content between PATCH and GET. */
	readonly driftPages = new Set<string>();
	driftFn: (markdown: string) => string = (m) => m;
	/** normalized ids excluded from POST /search results but still
	 * reachable via GET — simulates search-index lag. */
	readonly searchHidden = new Set<string>();
	/** Simulates the real /search defect: an `ascending` sort returns only
	 * this many pages with has_more=false (probed live: 45 of 879). */
	ascendingTruncatesTo: number | null = null;
	/** Parents with at least this many children lose some of them from
	 * /search (probed live: a 107-child folder came back with 99). */
	searchDropsChildrenOfHeavyParents = Number.POSITIVE_INFINITY;
	searchDroppedPerHeavyParent = 8;
	/** real Notion returns dashed uuids; some code paths break on that. */
	private readonly dashIds: boolean;

	constructor(opts: { dashIds?: boolean } = {}) {
		this.dashIds = opts.dashIds ?? false;
	}

	private nid(): string {
		const id = newId();
		if (!this.dashIds) return id;
		return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
	}

	private iso(t: number): string {
		return new Date(Math.floor(t / 60000) * 60000).toISOString();
	}

	/** fail the next matching request once. */
	failOnce(path?: RegExp, method?: string): void {
		this.failures.push({ path, method });
	}

	// ---- human-side helpers (bump the fake clock) ----
	humanEdit(pageId: string, newVisibleMarkdown: string): void {
		const p = this.must(pageId);
		p.markdown = newVisibleMarkdown;
		this.bump(p);
	}

	humanTrash(pageId: string): void {
		const p = this.must(pageId);
		this.bump(p);
		// real Notion trashes the whole subtree
		for (const q of this.pages.values()) {
			if (q === p || this.hasAncestor(q, p.id)) q.inTrash = true;
		}
		p.inTrash = true;
	}

	private hasAncestor(p: FakePage, ancestorId: string): boolean {
		let cur: string | undefined = p.parentId;
		const seen = new Set<string>();
		while (cur && !seen.has(cur)) {
			seen.add(cur);
			if (cur === norm(ancestorId)) return true;
			cur = this.pages.get(cur)?.parentId;
		}
		return false;
	}

	humanMove(pageId: string, newParentId: string): void {
		const p = this.must(pageId);
		p.parentId = norm(newParentId);
		this.bump(p);
	}

	/** Park a page under a non-page parent (column, toggle, synced block):
	 * the real API then reports `parent: { type: "block_id", … }`, which
	 * pageInfo cannot express and surfaces as `parent: null`. */
	humanReparentUnderBlock(pageId: string): void {
		const p = this.must(pageId);
		p.parentId = `block${p.id}`;
		this.bump(p);
	}

	humanRename(pageId: string, title: string): void {
		const p = this.must(pageId);
		p.title = title;
		this.bump(p);
	}

	humanCreatePage(
		parentId: string,
		title: string,
		icon: string | null = null,
	): string {
		const p = this.createPage(parentId, title, icon);
		this.bump(p);
		return p.id;
	}

	private bump(p: FakePage): void {
		this.humanClock += 60_000;
		p.lastEdited = this.now + this.humanClock;
	}

	private must(id: string): FakePage {
		const p = this.pages.get(norm(id));
		if (!p) throw new Error(`fake: no page ${id}`);
		return p;
	}

	private createPage(
		parentId: string,
		title: string,
		icon: string | null,
	): FakePage {
		const p: FakePage = {
			id: this.nid(),
			parentId: norm(parentId),
			title,
			icon,
			inTrash: false,
			markdown: "",
			lastEdited: this.now,
			createdTime: this.now,
		};
		// keyed by normalized id — the real API accepts dashed and
		// undashed forms interchangeably on every endpoint.
		this.pages.set(norm(p.id), p);
		return p;
	}

	// ---- RequestFn ----
	readonly request = async (req: HttpRequest): Promise<HttpResponse> => {
		const url = new URL(req.url);
		const path = url.pathname.replace(/^\/v1/, "");
		const method = req.method.toUpperCase();
		this.reqLog.push({ method, path });
		const fi = this.failures.findIndex(
			(f) =>
				(!f.method || f.method === method) &&
				(!f.path || f.path.test(path)),
		);
		if (fi >= 0) {
			this.failures.splice(fi, 1);
			return { status: 500, json: { message: "injected" }, headers: {} };
		}
		if (req.url.startsWith(FILES_BASE)) {
			const id = req.url.slice(FILES_BASE.length);
			const up = [...this.uploads.values()].find((u) => norm(u.id) === norm(id));
			if (!up?.bytes) {
				return { status: 404, json: {}, headers: {} };
			}
			return {
				status: 200,
				json: {},
				headers: {},
				arrayBuffer: up.bytes.buffer as ArrayBuffer,
			};
		}
		try {
			return {
				status: 200,
				json: this.route(method, path, url, req) ?? {},
				headers: {},
			};
		} catch (err) {
			const e = err as { status?: number; body?: unknown };
			return {
				status: e.status ?? 500,
				json: e.body ?? { message: String(err) },
				headers: {},
			};
		}
	};

	private apiErr(status: number, message: string): never {
		throw { status, body: { status, code: "fake", message } };
	}

	/** Mirrors the real API: writes under a trashed page/ancestor fail. */
	private assertEditable(p: FakePage): void {
		if (p.inTrash) {
			this.apiErr(400, "Can't edit block that is archived");
		}
		let cur: string | undefined = p.parentId;
		const seen = new Set<string>();
		while (cur && !seen.has(cur)) {
			seen.add(cur);
			const parent = this.pages.get(cur);
			if (parent?.inTrash) {
				this.apiErr(
					400,
					"Can't edit block that has an archived ancestor",
				);
			}
			cur = parent?.parentId;
		}
	}

	private assertParentEditable(parentId: string): void {
		const p = this.pages.get(norm(parentId));
		if (p) this.assertEditable(p);
	}

	private route(
		method: string,
		path: string,
		url: URL,
		req: HttpRequest,
	): unknown {
		const body =
			typeof req.body === "string" && req.body
				? (JSON.parse(req.body) as Record<string, unknown>)
				: {};
		const parts = path.split("/").filter(Boolean);

		if (method === "GET" && path === "/users/me") {
			return { object: "user", type: "bot", name: "fake-bot", id: "bot" };
		}
		if (method === "POST" && path === "/search") {
			this.searchRequests.push(body);
			return this.search(body, url);
		}
		if (method === "POST" && path === "/pages") {
			const parent = body.parent as { page_id?: string } | undefined;
			if (parent?.page_id) this.assertParentEditable(parent.page_id);
			const title = (
				(
					(body.properties as Record<string, unknown>)?.title as {
						title?: Array<{ text?: { content?: string } }>;
					}
				)?.title ?? []
			)
				.map((t) => t.text?.content ?? "")
				.join("");
			const icon =
				(body.icon as { emoji?: string } | undefined)?.emoji ?? null;
			const p = this.createPage(parent?.page_id ?? "", title, icon);
			return this.pageJson(p);
		}
		if (parts[0] === "pages" && parts.length >= 2) {
			const p = this.pages.get(norm(parts[1]!));
			if (!p) this.apiErr(404, "not found");
			if (parts.length === 2) {
				if (method === "GET") {
					if (p.inTrash) return { ...this.pageJson(p), in_trash: true };
					return this.pageJson(p);
				}
				if (method === "PATCH") {
					this.assertEditable(p);
					if (body.in_trash === true) {
						// real Notion trashes the whole subtree with the page
						for (const q of this.pages.values()) {
							if (q === p || this.hasAncestor(q, p.id))
								q.inTrash = true;
						}
					}
					if (body.in_trash === false) p.inTrash = false;
					const t = (
						(body.properties as Record<string, unknown>)?.title as {
							title?: Array<{ text?: { content?: string } }>;
						}
					)?.title;
					if (t) {
						p.title = t.map((x) => x.text?.content ?? "").join("");
					}
					const ic = body.icon as { emoji?: string } | undefined;
					if (ic?.emoji) p.icon = ic.emoji;
					return this.pageJson(p);
				}
			}
			if (parts[2] === "move" && method === "POST") {
				const parent = body.parent as { page_id?: string } | undefined;
				if (!parent?.page_id) this.apiErr(400, "bad parent");
				this.assertEditable(p);
				this.assertParentEditable(parent.page_id);
				p.parentId = norm(parent.page_id);
				return this.pageJson(p);
			}
			if (parts[2] === "markdown") {
				if (method === "GET") {
					let md = this.markdownOf(p);
					if (this.driftPages.delete(p.id)) {
						md = this.driftFn(md);
					}
					return { markdown: md };
				}
				if (method === "PATCH") {
					this.assertEditable(p);
					return this.patchMarkdown(p, body);
				}
			}
		}
		if (parts[0] === "blocks" && parts.length >= 2) {
			const id = norm(parts[1]!);
			if (parts.length === 2 && method === "DELETE") {
				const b = this.blocks.get(id);
				if (b) b.inTrash = true;
				const pg = this.pages.get(id);
				if (pg) pg.inTrash = true;
				return {};
			}
			if (parts[2] === "children") {
				if (method === "GET") {
					return this.listChildren(id, url);
				}
				if (method === "PATCH") {
					const pg = this.pages.get(id);
					if (pg) this.assertEditable(pg);
					return this.appendChildren(id, body);
				}
			}
		}
		if (parts[0] === "file_uploads") {
			if (parts.length === 1 && method === "POST") {
				const up: FakeUpload = {
					id: this.nid(),
					filename: String(body.filename ?? "file"),
					contentType: String(body.content_type ?? ""),
					mode:
						body.mode === "multi_part"
							? "multi_part"
							: "single_part",
					bytes: null,
					parts: new Map(),
				};
				this.uploads.set(norm(up.id), up);
				return { id: up.id, status: "pending" };
			}
			const up = this.uploads.get(norm(parts[1]!));
			if (!up) this.apiErr(404, "no upload");
			if (parts[2] === "send" && method === "POST") {
				const parsed = this.parseMultipart(req);
				if (up.mode === "multi_part") {
					const pn = Number(parsed.fields.part_number);
					if (!Number.isInteger(pn) || pn < 1) {
						this.apiErr(400, "missing part_number");
					}
					up.parts.set(pn, parsed.file);
				} else {
					up.bytes = parsed.file;
				}
				return { id: up.id, status: "pending" };
			}
			if (parts[2] === "complete" && method === "POST") {
				const n = up.parts.size;
				const total = [...up.parts.values()].reduce(
					(s, b) => s + b.length,
					0,
				);
				const out = new Uint8Array(total);
				let off = 0;
				for (let i = 1; i <= n; i++) {
					const part = up.parts.get(i);
					if (!part) this.apiErr(400, `missing part ${i}`);
					out.set(part!, off);
					off += part!.length;
				}
				up.bytes = out;
				return { id: up.id, status: "uploaded" };
			}
			if (method === "GET") {
				return {
					id: up.id,
					status: up.bytes ? "uploaded" : "pending",
				};
			}
		}
		this.apiErr(404, `fake: unhandled ${method} ${path}`);
	}

	/** Split a multipart/form-data body into named fields + the file part. */
	private parseMultipart(req: HttpRequest): {
		file: Uint8Array;
		fields: Record<string, string>;
	} {
		const raw =
			typeof req.body === "string"
				? new TextEncoder().encode(req.body)
				: new Uint8Array(
						(req.body as ArrayBuffer) ?? new ArrayBuffer(0),
					);
		// boundary = first line ("--xxxx\r\n")
		const eol = indexOfBytes(raw, 0x0a);
		const boundary = raw.slice(0, eol - 1); // includes "--"
		const segments = splitOnBytes(raw, boundary).slice(1); // drop preamble
		const fields: Record<string, string> = {};
		let file = new Uint8Array(0);
		for (const seg of segments) {
			const hdrEnd = indexOfSeq(seg, [0x0d, 0x0a, 0x0d, 0x0a]);
			if (hdrEnd < 0) continue;
			const header = new TextDecoder().decode(seg.slice(0, hdrEnd));
			const name = header.match(/name="([^"]+)"/)?.[1];
			if (!name) continue;
			// body ends with \r\n before the next boundary
			let body = seg.slice(hdrEnd + 4);
			if (
				body.length >= 2 &&
				body[body.length - 2] === 0x0d &&
				body[body.length - 1] === 0x0a
			) {
				body = body.slice(0, body.length - 2);
			}
			if (name === "file") file = body;
			else fields[name] = new TextDecoder().decode(body);
		}
		return { file, fields };
	}

	private pageJson(p: FakePage): Record<string, unknown> {
		return {
			object: "page",
			id: p.id,
			parent:
				p.parentId !== "" && !this.pages.has(p.parentId)
					? { type: "block_id", block_id: p.parentId }
					: { type: "page_id", page_id: p.parentId },
			properties: {
				title: { title: [{ plain_text: p.title }] },
			},
			icon: p.icon ? { type: "emoji", emoji: p.icon } : null,
			in_trash: p.inTrash,
			last_edited_time: this.iso(p.lastEdited),
			created_time: this.iso(p.createdTime),
		};
	}

	private childPageLines(p: FakePage): string[] {
		return [...this.pages.values()]
			.filter((c) => c.parentId === p.id && !c.inTrash)
			.map(
				(c) =>
					`<page url="https://www.notion.so/${c.id}">${c.title}</page>`,
			);
	}

	private markdownOf(p: FakePage): string {
		const lines = this.childPageLines(p);
		const stored = p.markdown.trim();
		return [stored, ...lines].filter(Boolean).join("\n");
	}

	private stripChildLines(md: string): string {
		return md
			.split("\n")
			.filter(
				(l) =>
					!l.trim().startsWith("<page") &&
					!l.trim().startsWith("<database"),
			)
			.join("\n");
	}

	private patchMarkdown(
		p: FakePage,
		body: Record<string, unknown>,
	): { markdown: string } {
		const type = body.type as string;
		if (type === "replace_content") {
			const newStr = String(
				(body.replace_content as { new_str?: string })?.new_str ?? "",
			);
			const needed = this.childPageLines(p);
			if (
				needed.length > 0 &&
				!needed.every((l) => newStr.includes(l))
			) {
				this.apiErr(400, "would delete child page content");
			}
			p.markdown = this.stripChildLines(newStr);
			return { markdown: this.markdownOf(p) };
		}
		if (type === "update_content") {
			const updates =
				(
					body.update_content as {
						content_updates?: Array<{
							old_str?: string;
							new_str?: string;
						}>;
					}
				)?.content_updates ?? [];
			let md = p.markdown;
			for (const u of updates) {
				const oldStr = u.old_str ?? "";
				if (oldStr && !md.includes(oldStr)) {
					this.apiErr(400, "old_str not found");
				}
				md = md.split(oldStr).join(u.new_str ?? "");
			}
			p.markdown = md;
			return { markdown: this.markdownOf(p) };
		}
		this.apiErr(400, `unknown markdown op ${type}`);
	}

	/** Raw block list of a page — tests append blocks to fake remote state. */
	allBlocksFor(parentId: string): FakeBlock[] {
		const content = [...this.blocks.values()].filter(
			(b) => b.parentId === parentId,
		);
		// child pages as synthetic child_page blocks (in creation order)
		const children = [...this.pages.values()]
			.filter((pg) => pg.parentId === parentId)
			.map<FakeBlock>((pg) => ({
				id: pg.id,
				parentId,
				type: "child_page",
				data: {
					child_page: { title: pg.title },
					has_children:
						[...this.pages.values()].some(
							(c) => c.parentId === norm(pg.id),
						) ||
						[...this.blocks.values()].some(
							(b) => b.parentId === norm(pg.id),
						),
				},
				inTrash: pg.inTrash,
				createdTime: pg.createdTime,
			}));
		return [...content, ...children];
	}

	private listChildren(parentId: string, url: URL): unknown {
		const pageSize = Number(url.searchParams.get("page_size") ?? 100);
		const start = Number(url.searchParams.get("start_cursor") ?? 0);
		const all = this.allBlocksFor(parentId).filter((b) => !b.inTrash);
		const slice = all.slice(start, start + pageSize);
		const next = start + pageSize;
		return {
			results: slice.map((b) => ({
				id: b.id,
				type: b.type,
				in_trash: b.inTrash,
				created_time: this.iso(b.createdTime),
				...b.data,
			})),
			has_more: next < all.length,
			next_cursor: next < all.length ? String(next) : null,
		};
	}

	private appendChildren(
		parentId: string,
		body: Record<string, unknown>,
	): unknown {
		const children = (body.children ?? []) as Array<
			Record<string, unknown>
		>;
		const position = (body.position as { type?: string } | undefined)
			?.type;
		const made: FakeBlock[] = [];
		for (const c of children) {
			const type = String(c.type ?? "paragraph");
			const data: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(c)) {
				if (k === "type") continue;
				data[k] = v;
				if (
					typeof v === "object" &&
					v !== null &&
					(v as { file_upload?: { id?: string } }).file_upload?.id
				) {
					const upId = norm(
						(v as { file_upload: { id: string } }).file_upload.id,
					);
					data[k] = {
						type: "file_upload",
						file: { url: `${FILES_BASE}${upId}` },
						caption: (v as { caption?: unknown }).caption ?? [],
					};
				}
			}
			made.push({
				id: this.nid(),
				parentId,
				type,
				data,
				inTrash: false,
				createdTime: this.now,
			});
		}
		// position start → prepend preserving order
		const existing = [...this.blocks.values()].filter(
			(b) => b.parentId === parentId,
		);
		for (const b of existing) this.blocks.delete(norm(b.id));
		const ordered =
			position === "start" ? [...made, ...existing] : [...existing, ...made];
		for (const b of ordered) this.blocks.set(norm(b.id), b);
		return { results: made.map((b) => ({ id: b.id, type: b.type })) };
	}

	private search(body: Record<string, unknown>, url: URL): unknown {
		void url;
		const pageSize = Number(body.page_size ?? 100);
		const start = Number(body.start_cursor ?? 0);
		const ascending =
			(body.sort as { direction?: string } | undefined)?.direction ===
			"ascending";
		const live = [...this.pages.values()].filter(
			(p) => !p.inTrash && !this.searchHidden.has(norm(p.id)),
		);

		// real Notion defect: ascending returns a truncated single page
		if (ascending && this.ascendingTruncatesTo !== null) {
			const cut = live
				.sort((a, b) => a.lastEdited - b.lastEdited)
				.slice(0, this.ascendingTruncatesTo);
			return {
				results: cut.map((p) => this.pageJson(p)),
				has_more: false,
				next_cursor: null,
			};
		}

		// real Notion defect: heavy parents lose some children from the index
		let visible = live;
		if (Number.isFinite(this.searchDropsChildrenOfHeavyParents)) {
			const perParent = new Map<string, number>();
			for (const p of live) {
				if (!p.parentId) continue;
				perParent.set(p.parentId, (perParent.get(p.parentId) ?? 0) + 1);
			}
			const seenPerParent = new Map<string, number>();
			visible = live.filter((p) => {
				if (!p.parentId) return true;
				const total = perParent.get(p.parentId) ?? 0;
				if (total < this.searchDropsChildrenOfHeavyParents) return true;
				const n = (seenPerParent.get(p.parentId) ?? 0) + 1;
				seenPerParent.set(p.parentId, n);
				return n <= total - this.searchDroppedPerHeavyParent;
			});
		}

		const all = visible.sort((a, b) =>
			ascending
				? a.lastEdited - b.lastEdited
				: b.lastEdited - a.lastEdited,
		);
		const slice = all.slice(start, start + pageSize);
		const next = start + pageSize;
		return {
			results: slice.map((p) => this.pageJson(p)),
			has_more: next < all.length,
			next_cursor: next < all.length ? String(next) : null,
		};
	}
}
