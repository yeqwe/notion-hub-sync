// Live invariant test for Notion-side render drift: after pushing ~20
// corpus notes, subsequent rounds must produce zero pulls/local writes
// when nobody edits in the Notion UI — while a real remote edit
// (update_content on one sentence) must still be detected and pulled.
// Fresh container, trashed at the end.

import { describe, expect, it } from "vitest";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { NotionClient, type RequestFn } from "../notion/client";
import { emptyState } from "../sync/state";
import type { SyncReport } from "../sync/deps";
import { NodeVaultIO } from "../../test-support/node-vault-io";
import { NodeConfigIO } from "../../test-support/node-config-io";
import { BaseStore, type TextIO } from "./base-store";
import { runSync, type EngineDeps } from "./sync";
import { defaultConfigSync } from "../config/filter";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS = join(ROOT, "probe", "corpus");

function loadEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	const p = join(ROOT, ".env.local");
	if (!existsSync(p)) return env;
	for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
		if (m && !line.trimStart().startsWith("#")) {
			env[m[1] as string] = (m[2] as string).replace(/^["']|["']$/g, "");
		}
	}
	return env;
}

function parseId(input: string): string | null {
	let p = (input ?? "").trim();
	try {
		p = new URL(p).pathname;
	} catch {}
	const hex = p.match(/[0-9a-fA-F]{32}/g)?.pop();
	return hex ? hex.toLowerCase() : null;
}

const env = loadEnv();
const token = env.NOTION_TOKEN;
const userRoot = parseId(env.NOTION_ROOT_PAGE ?? "");
const haveCreds = Boolean(token && userRoot);

const realRequest = (): RequestFn => {
	return async (req) => {
		const res = await fetch(req.url, {
			method: req.method,
			headers: req.headers,
			body: req.body,
		});
		const ab = await res.arrayBuffer();
		let json: unknown = null;
		try {
			json = JSON.parse(Buffer.from(ab).toString("utf8"));
		} catch {}
		const headers: Record<string, string> = {};
		res.headers.forEach((v, k) => {
			headers[k.toLowerCase()] = v;
		});
		return { status: res.status, json, headers, arrayBuffer: ab };
	};
};

function nodeTextIO(root: string): TextIO {
	return {
		read: async (p) => readFileSync(join(root, p), "utf8"),
		write: async (p, c) => {
			const abs = join(root, p);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, c);
		},
		remove: async () => {},
	};
}

function liveDevice(rootId: string, label: string) {
	const dir = mkdtempSync(join(tmpdir(), `nhs-drift-${label}-`));
	const state = emptyState(rootId);
	const deps: EngineDeps = {
		vault: new NodeVaultIO(dir),
		client: new NotionClient({ token: token!, request: realRequest() }),
		state,
		saveState: async () => {},
		resolvePath: () => null,
		deviceId: `${label}drift-4000-8000-000000000000`,
		history: {
			enabled: false,
			intervalMinutes: 0,
			maxVersions: 50,
			retentionDays: 30,
		},
		baseStore: new BaseStore(nodeTextIO(dir), ".nhs"),
		engine: { fullAuditHours: 6, roundRobinPerRound: 50 },
		configIO: new NodeConfigIO(dir),
		configSync: { ...defaultConfigSync(), enabled: false },
		selfId: "notion-hub-sync",
		isMobile: false,
	};
	return {
		dir,
		deps,
		state,
		sync: (): Promise<SyncReport> => runSync(deps, { full: false }),
	};
}

describe.skipIf(!haveCreds)("render drift (live)", () => {
	it("push → N rounds produce zero pulls; remote edit still detected", async () => {
		const setupClient = new NotionClient({
			token: token!,
			request: realRequest(),
		});
		const container = await setupClient.request<{ id: string }>(
			"POST",
			"/pages",
			{
				parent: { page_id: userRoot },
				properties: {
					title: {
						title: [{ text: { content: "nhs-drift" } }],
					},
				},
			},
		);
		const rootId = container.id;
		const a = liveDevice(rootId, "a");
		const b = liveDevice(rootId, "b");
		try {
			// ~20 corpus notes + one marker note for the remote edit
			const files = readdirSync(CORPUS)
				.filter((f) => f.endsWith(".md"))
				.slice(0, 20);
			for (const f of files) {
				writeFileSync(
					join(a.dir, f),
					readFileSync(join(CORPUS, f), "utf8"),
				);
			}
			writeFileSync(
				join(a.dir, "marker.md"),
				"# marker\n\nUNIQUE-SENT-0001 stays here\n",
			);

			const r0 = await a.sync();
			expect(r0.failed).toBe(0);
			console.log(
				`    [drift] bootstrap c=${r0.created} u=${r0.updated}`,
			);

			// snapshot all local bytes for the invariant check
			const snapshot = new Map<string, Buffer>();
			for (const f of [...files, "marker.md"]) {
				snapshot.set(f, readFileSync(join(a.dir, f)));
			}

			for (let round = 1; round <= 2; round++) {
				const r = await a.sync();
				console.log(
					`    [drift] a round${round} c=${r.created} u=${r.updated} f=${r.failed}`,
				);
				expect(r.updated).toBe(0);
				expect(r.created).toBe(0);
				for (const [f, buf] of snapshot) {
					expect(readFileSync(join(a.dir, f)).equals(buf)).toBe(true);
				}
			}

			// second device pulls, then must also stay quiet
			const rb0 = await b.sync();
			console.log(
				`    [drift] b bootstrap c=${rb0.created} u=${rb0.updated} f=${rb0.failed}`,
			);
			expect(rb0.failed).toBe(0);
			const bSnapshot = new Map<string, Buffer>();
			for (const f of [...files, "marker.md"]) {
				bSnapshot.set(f, readFileSync(join(b.dir, f)));
			}
			const rb1 = await b.sync();
			console.log(
				`    [drift] b round1 c=${rb1.created} u=${rb1.updated} f=${rb1.failed}`,
			);
			expect(rb1.updated).toBe(0);
			for (const [f, buf] of bSnapshot) {
				expect(readFileSync(join(b.dir, f)).equals(buf)).toBe(true);
			}

			// real remote edit: update_content on the marker sentence
			// (source toggle stays intact)
			const markerId = Object.entries(a.state.entries).find(
				([, e]) => e.path === "marker.md",
			)?.[0];
			expect(markerId).toBeTruthy();
			const edit = await setupClient.request(
				"PATCH",
				`/pages/${markerId}/markdown`,
				{
					type: "update_content",
					update_content: {
						content_updates: [
							{
								old_str: "UNIQUE-SENT-0001 stays here",
								new_str: "HUMAN-WROTE-02 replaced it",
							},
						],
					},
				},
			);
			void edit;
			const r2 = await a.sync();
			console.log(
				`    [drift] a post-edit c=${r2.created} u=${r2.updated} f=${r2.failed}`,
			);
			expect(r2.updated).toBe(1);
			expect(
				readFileSync(join(a.dir, "marker.md"), "utf8"),
			).toContain("HUMAN-WROTE-02");
		} finally {
			await setupClient
				.request("PATCH", `/pages/${rootId}`, { in_trash: true })
				.catch(() => undefined);
		}
	}, 600_000);
});
