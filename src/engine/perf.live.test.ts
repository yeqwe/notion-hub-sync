// Live performance measurement (not an assertion test): fresh container
// with 20 notes in 2 folders + 2 small images; reports wall time and
// request count for first sync, an idle round, and a one-edit round.
// Run: npm run test:live (skips without creds).

import { describe, expect, it } from "vitest";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NotionClient, type RequestFn } from "../notion/client";
import { emptyState } from "../sync/state";
import type { SyncReport } from "../sync/deps";
import { NodeVaultIO } from "../../test-support/node-vault-io";
import { NodeConfigIO } from "../../test-support/node-config-io";
import { BaseStore, type TextIO } from "./base-store";
import { runSync, type EngineDeps } from "./sync";
import { defaultConfigSync } from "../config/filter";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

type Counter = { n: number; byOp: Record<string, number> };

const realRequest = (counter: Counter): RequestFn => {
	return async (req) => {
		counter.n++;
		const u = new URL(req.url);
		const key = `${req.method} ${u.pathname.replace(
			/\/[0-9a-f]{32}/g,
			"/{id}",
		)}`;
		counter.byOp[key] = (counter.byOp[key] ?? 0) + 1;
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

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

describe.skipIf(!haveCreds)("perf measurement (live)", () => {
	it("measures first sync / idle / one-edit round", async () => {
		const setupClient = new NotionClient({
			token: token!,
			request: realRequest({ n: 0, byOp: {} }),
		});
		const container = await setupClient.request<{ id: string }>(
			"POST",
			"/pages",
			{
				parent: { page_id: userRoot },
				properties: {
					title: { title: [{ text: { content: "nhs-perf" } }] },
				},
			},
		);
		const rootId = container.id;
		const counter: Counter = { n: 0, byOp: {} };
		const dir = mkdtempSync(join(tmpdir(), "nhs-perf-"));
		try {
			for (const f of ["f1", "f2"]) {
				mkdirSync(join(dir, f), { recursive: true });
				for (let i = 0; i < 10; i++) {
					writeFileSync(join(dir, f, `n${i}.md`), `# ${f} n${i}\nbody\n`);
				}
			}
			writeFileSync(join(dir, "a.png"), PNG);
			writeFileSync(join(dir, "b.png"), PNG);

			const state = emptyState(rootId);
			const deps: EngineDeps = {
				vault: new NodeVaultIO(dir),
				client: new NotionClient({
					token: token!,
					request: realRequest(counter),
				}),
				state,
				saveState: async () => {},
				log: (m) => console.log(`    [act] ${m}`),
				resolvePath: () => null,
				deviceId: "perf-0000-4000-8000-000000000000",
				history: {
					enabled: true,
					intervalMinutes: 0,
					maxVersions: 50,
					retentionDays: 30,
				},
				baseStore: new BaseStore(nodeTextIO(dir), ".nhs"),
				engine: { fullAuditHours: 6, roundRobinPerRound: 3 },
				configIO: new NodeConfigIO(dir),
				configSync: { ...defaultConfigSync(), enabled: false },
				selfId: "notion-hub-sync",
				isMobile: false,
			};

			const round = async (
				label: string,
			): Promise<SyncReport> => {
				const t0 = Date.now();
				counter.n = 0;
				counter.byOp = {};
				const r = await runSync(deps, { full: false });
				console.log(
					`    [perf] ${label}: ${Date.now() - t0}ms, ` +
						`${counter.n} req ${JSON.stringify(counter.byOp)} ` +
						`report=${JSON.stringify({ c: r.created, u: r.updated, f: r.failed })}`,
				);
				return r;
			};

			const first = await round("first sync");
			expect(first.failed).toBe(0);
			const idle = await round("idle");
			expect(idle.failed).toBe(0);
			writeFileSync(join(dir, "f1", "n0.md"), "# f1 n0\nedited\n");
			const edit = await round("one edit");
			expect(edit.failed).toBe(0);
		} finally {
			await setupClient
				.request("PATCH", `/pages/${rootId}`, { in_trash: true })
				.catch(() => undefined);
		}
	}, 600_000);
});
