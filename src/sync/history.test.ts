import { describe, expect, it } from "vitest";
import {
	encodeCaption,
	ensureHistoryPage,
	parseCaption,
	recordVersion,
	listVersions,
	type VersionCaption,
} from "./history";
import { NotionClient, type HttpRequest } from "../notion/client";
import { emptyState, type SyncState } from "./state";
import type { SyncDeps } from "./deps";
import { sha256Hex } from "./hashes";
import { RenameTracker } from "./rename-tracker";

const enc = new TextEncoder();

function caption(
	over: Partial<VersionCaption> = {},
): VersionCaption {
	return {
		v: 1,
		t: "2026-10-22T12:00:00.000Z",
		d: "dev12345",
		s: "a".repeat(64),
		z: 10,
		p: "Note.md",
		r: "push",
		...over,
	};
}

function fileBlock(id: string, cap: VersionCaption) {
	return {
		id,
		type: "file",
		file: {
			type: "file",
			file: { url: `https://s3/${id}` },
			caption: [{ type: "text", text: { content: encodeCaption(cap) } }],
		},
	};
}

interface Router {
	handlers: Array<{
		match: (r: HttpRequest) => boolean;
		respond: (r: HttpRequest) => unknown;
	}>;
}

function makeClient(
	router: Router,
): { client: NotionClient; calls: HttpRequest[] } {
	const calls: HttpRequest[] = [];
	const client = new NotionClient({
		token: "t",
		minIntervalMs: 0,
		maxRetries: 0,
		request: async (r) => {
			calls.push(r);
			for (const h of router.handlers) {
				if (h.match(r)) {
					return { status: 200, json: h.respond(r), headers: {} };
				}
			}
			return { status: 404, json: { message: "unrouted" }, headers: {} };
		},
	});
	return { client, calls };
}

function page(url: string) {
	return (r: HttpRequest) => r.method === "GET" && r.url.includes(url);
}

function makeDeps(
	client: NotionClient,
	state: SyncState,
	over: Partial<SyncDeps> = {},
): SyncDeps {
	return {
		vault: {
			list: async () => ({ files: [], folders: [] }),
			readText: async () => "",
			readBinary: async () => new ArrayBuffer(0),
			writeText: async () => {},
			writeBinary: async () => {},
			mkdirp: async () => {},
			exists: async () => false,
			stat: async () => null,
			rename: async () => {},
			trash: async () => {},
		renames: new RenameTracker(),
		writes: new RenameTracker(),
		},
		client,
		state,
		saveState: async () => {},
		resolvePath: () => null,
		deviceId: "dev12345abcdef",
		history: {
			enabled: true,
			intervalMinutes: 10,
			maxVersions: 50,
			retentionDays: 30,
		},
		...over,
	};
}

const PAGE_ID = "a".repeat(32);

function noteEntry(state: SyncState): void {
	state.entries[PAGE_ID] = {
		path: "Note.md",
		kind: "note",
		notionTitle: "Note",
		parentId: "root",
	};
}

function uploadRouter(router: Router): void {
	router.handlers.push(
		{
			match: (r) =>
				r.method === "POST" && r.url.endsWith("/file_uploads"),
			respond: () => ({ id: "upload-1" }),
		},
		{
			match: (r) => r.method === "POST" && r.url.includes("/send"),
			respond: () => ({ status: "uploaded" }),
		},
		{
			match: (r) => r.method === "PATCH" && r.url.includes("/children"),
			respond: () => ({ results: [] }),
		},
		{
			match: (r) => r.method === "DELETE" && r.url.includes("/blocks/"),
			respond: () => ({ id: "deleted" }),
		},
		{
			match: (r) => r.method === "POST" && r.url.endsWith("/pages"),
			respond: (r) => {
				const body = JSON.parse(r.body as string) as {
					icon?: { emoji?: string };
					properties?: { title?: { title?: Array<{ text?: { content?: string } }> } };
				};
				return { id: `${"f".repeat(8)}-${"f".repeat(4)}-${"f".repeat(4)}-${"f".repeat(4)}-${"f".repeat(12)}`, _body: body };
			},
		},
		{
			match: (r) =>
				r.method === "GET" && r.url.includes("/children?page_size"),
			respond: () => ({ results: [], has_more: false }),
		},
	);
}

describe("caption codec", () => {
	it("round-trips v1 captions", () => {
		const c = caption({ r: "pre-pull" });
		expect(parseCaption(encodeCaption(c))).toEqual(c);
	});

	it("rejects invalid JSON and non-v1 objects", () => {
		expect(parseCaption("not json")).toBeNull();
		expect(parseCaption('{"v":2}')).toBeNull();
		expect(parseCaption('{"v":1,"t":"x"}')).toBeNull();
		expect(parseCaption("")).toBeNull();
	});
});

describe("listVersions", () => {
	it("parses captions, keeps order, ignores non-version blocks", async () => {
		const router: Router = { handlers: [] };
		router.handlers.push({
			match: page("/children"),
			respond: () => ({
				results: [
					fileBlock("b1", caption({ t: "2026-10-22T13:00:00.000Z" })),
					{ id: "b-x", type: "paragraph", paragraph: {} },
					{
						id: "b-bad",
						type: "file",
						file: {
							caption: [
								{ type: "text", text: { content: "hello" } },
							],
						},
					},
					fileBlock("b2", caption({ t: "2026-10-22T12:00:00.000Z" })),
				],
				has_more: false,
			}),
		});
		const { client } = makeClient(router);
		const res = await listVersions(client, "hist1");
		expect(res.versions.map((v) => v.blockId)).toEqual(["b1", "b2"]);
		expect(res.versions[0]!.url).toBe("https://s3/b1");
	});
});

describe("ensureHistoryPage", () => {
	it("returns entry.historyPageId without requests", async () => {
		const router: Router = { handlers: [] };
		const { client, calls } = makeClient(router);
		const state = emptyState("root");
		noteEntry(state);
		state.entries[PAGE_ID]!.historyPageId = "hp1";
		const deps = makeDeps(client, state);
		expect(await ensureHistoryPage(deps, PAGE_ID)).toBe("hp1");
		expect(calls).toHaveLength(0);
	});

	it("finds an existing history page via container listing", async () => {
		const router: Router = { handlers: [] };
		router.handlers.push(
			{
				match: (r) =>
					r.method === "GET" && r.url.includes("/children"),
				respond: () => ({
					results: [
						{
							id: "hp-found",
							type: "child_page",
							child_page: { title: PAGE_ID },
						},
						{
							id: "hp-other",
							type: "child_page",
							child_page: { title: "b".repeat(32) },
						},
					],
					has_more: false,
				}),
			},
		);
		uploadRouter(router);
		const { client } = makeClient(router);
		const state = emptyState("root");
		state.historyRootId = "container";
		noteEntry(state);
		const deps = makeDeps(client, state);
		const id = await ensureHistoryPage(deps, PAGE_ID);
		expect(id).toBe("hpfound"); // dashes stripped, lowercased
		expect(state.entries[PAGE_ID]!.historyPageId).toBe("hpfound");
	});

	it("creates container + history page lazily", async () => {
		const router: Router = { handlers: [] };
		uploadRouter(router);
		const { client, calls } = makeClient(router);
		const state = emptyState("root");
		noteEntry(state);
		const deps = makeDeps(client, state);
		const id = await ensureHistoryPage(deps, PAGE_ID);
		expect(id).toBe("f".repeat(32));
		expect(state.historyRootId).toBe("f".repeat(32));
		// two page creates: container + history page
		const creates = calls.filter(
			(r) => r.method === "POST" && r.url.endsWith("/pages"),
		);
		expect(creates).toHaveLength(2);
		const first = JSON.parse(creates[0]!.body as string) as {
			icon?: { emoji?: string };
		};
		expect(first.icon?.emoji).toBe("🗄️");
	});
});

describe("recordVersion", () => {
	const content = enc.encode("v1 content");

	async function pushedDeps(
		extra: Partial<SyncDeps> = {},
		mutate?: (s: SyncState) => void,
	) {
		const router: Router = { handlers: [] };
		uploadRouter(router);
		const { client, calls } = makeClient(router);
		const state = emptyState("root");
		noteEntry(state);
		state.entries[PAGE_ID]!.historyPageId = "hp1";
		mutate?.(state);
		const deps = makeDeps(client, state, extra);
		return { deps, calls, state };
	}

	it("uploads and appends a block with position start + JSON caption", async () => {
		const { deps, calls } = await pushedDeps();
		const res = await recordVersion(
			deps,
			PAGE_ID,
			"Note.md",
			content,
			"push",
		);
		expect(res).toBe("recorded");
		const methods = calls.map(
			(c) => `${c.method} ${new URL(c.url).pathname}`,
		);
		expect(methods.slice(0, 3)).toEqual([
			"POST /v1/file_uploads",
			"POST /v1/file_uploads/upload-1/send",
			"PATCH /v1/blocks/hp1/children",
		]);
		const patch = JSON.parse(calls[2]!.body as string) as {
			position: { type: string };
			children: Array<{
				type: string;
				file: { caption: Array<{ text: { content: string } }> };
			}>;
		};
		expect(patch.position.type).toBe("start");
		const cap = parseCaption(
			patch.children[0]!.file.caption[0]!.text.content,
		);
		expect(cap?.r).toBe("push");
		expect(cap?.p).toBe("Note.md");
		expect(cap?.s).toBe(await sha256Hex(content));
		// versionCount incremented; retention listing is gated (vc=1 → none)
		const { calls: c2 } = { calls };
		expect(
			c2.filter((c) => c.method === "GET" && c.url.includes("/children")),
		).toHaveLength(0);
	});

	it("throttles repeat push versions inside the interval", async () => {
		const { deps, calls } = await pushedDeps(
			{},
			(s) => {
				s.entries[PAGE_ID]!.lastVersionAt = 1_000_000;
				s.entries[PAGE_ID]!.lastVersionSha = "different";
			},
		);
		const res = await recordVersion(
			{ ...deps, now: () => 1_000_000 + 60_000 },
			PAGE_ID,
			"Note.md",
			content,
			"push",
		);
		expect(res).toBe("skipped");
		expect(calls).toHaveLength(0);
	});

	it("does not interval-throttle pre-pull versions", async () => {
		const { deps } = await pushedDeps({}, (s) => {
			s.entries[PAGE_ID]!.lastVersionAt = 1_000_000;
			s.entries[PAGE_ID]!.lastVersionSha = "different";
		});
		const res = await recordVersion(
			{ ...deps, now: () => 1_000_000 + 60_000 },
			PAGE_ID,
			"Note.md",
			content,
			"pre-pull",
		);
		expect(res).toBe("recorded");
	});

	it("skips when sha equals the newest recorded version", async () => {
		const sha = await sha256Hex(content);
		const { deps, calls } = await pushedDeps({}, (s) => {
			s.entries[PAGE_ID]!.lastVersionSha = sha;
		});
		expect(
			await recordVersion(deps, PAGE_ID, "Note.md", content, "pre-pull"),
		).toBe("skipped");
		expect(calls).toHaveLength(0);
	});

	it("skips when disabled", async () => {
		const { deps, calls } = await pushedDeps({
			history: {
				enabled: false,
				intervalMinutes: 0,
				maxVersions: 50,
				retentionDays: 30,
			},
		});
		expect(
			await recordVersion(deps, PAGE_ID, "Note.md", content, "push"),
		).toBe("skipped");
		expect(calls).toHaveLength(0);
	});

	it("prunes blocks past maxVersions, oldest first, max 5 deletes", async () => {
		const router: Router = { handlers: [] };
		// children listing returns 7 version blocks (newest first) —
		// register BEFORE the generic uploadRouter GET handler
		const old = "2026-10-20T00:00:00.000Z";
		router.handlers.push({
			match: (r) =>
				r.method === "GET" && r.url.includes("/children"),
			respond: () => ({
				results: [
					fileBlock("n1", caption()),
					fileBlock("o1", caption({ t: old })),
					fileBlock("o2", caption({ t: old })),
					fileBlock("o3", caption({ t: old })),
					fileBlock("o4", caption({ t: old })),
					fileBlock("o5", caption({ t: old })),
					fileBlock("o6", caption({ t: old })),
				],
				has_more: false,
			}),
		});
		uploadRouter(router);
		const { client, calls } = makeClient(router);
		const state = emptyState("root");
		noteEntry(state);
		state.entries[PAGE_ID]!.historyPageId = "hp1";
		// 50th recorded version → retention listing runs (every 10th rule)
		state.entries[PAGE_ID]!.versionCount = 49;
		const deps = makeDeps(client, state, {
			history: {
				enabled: true,
				intervalMinutes: 0,
				maxVersions: 50,
				retentionDays: 1,
			},
			now: () => Date.parse("2026-10-22T12:00:00.000Z"),
		});
		await recordVersion(deps, PAGE_ID, "Note.md", content, "push");
		const deletes = calls
			.filter((c) => c.method === "DELETE")
			.map((c) => new URL(c.url).pathname.split("/").pop());
		expect(deletes).toEqual(["o1", "o2", "o3", "o4", "o5"]); // max 5
	});
});
