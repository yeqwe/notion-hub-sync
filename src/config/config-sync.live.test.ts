// Live config-dir sync test: two Node devices against real Notion.
// Small version of offline scenario (a)+(b): config bootstrap then an
// edit propagated back through the journal. Fresh container, trashed at end.

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
import { BaseStore, type TextIO } from "../engine/base-store";
import { runSync, type EngineDeps } from "../engine/sync";
import { defaultConfigSync } from "./filter";

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

const realRequest = (n: { n: number }): RequestFn => {
	return async (req) => {
		n.n++;
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
		remove: async (p) => {
			try {
				await import("node:fs").then((fs) =>
					fs.unlinkSync(join(root, p)),
				);
			} catch {
				/* missing */
			}
		},
	};
}

function liveDevice(rootId: string, label: string) {
	const counter = { n: 0 };
	const dir = mkdtempSync(join(tmpdir(), `nhs-cfg-${label}-`));
	const vault = new NodeVaultIO(dir);
	const state = emptyState(rootId);
	const deps: EngineDeps = {
		vault,
		client: new NotionClient({
			token: token!,
			request: realRequest(counter),
		}),
		state,
		saveState: async () => {},
		resolvePath: () => null,
		deviceId: `${label}cfg-0000-4000-8000-000000000000`,
		history: {
			enabled: true,
			intervalMinutes: 0,
			maxVersions: 50,
			retentionDays: 30,
		},
		baseStore: new BaseStore(nodeTextIO(dir), ".nhs"),
		engine: { fullAuditHours: 6, roundRobinPerRound: 10 },
		configIO: new NodeConfigIO(dir),
		configSync: defaultConfigSync(),
		selfId: "notion-hub-sync",
		isMobile: false,
	};
	return {
		dir,
		state,
		deps,
		counter,
		sync: async (full = false): Promise<SyncReport> => {
			const t0 = Date.now();
			counter.n = 0;
			const r = await runSync(deps, { full });
			console.log(
				`    [${label}] sync(full=${full}) ${Date.now() - t0}ms, ` +
					`${counter.n} requests, report=${JSON.stringify(r)}`,
			);
			return r;
		},
		cwrite: (rel: string, c: string) => {
			const p = join(dir, ".obsidian", ...rel.split("/"));
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, c);
		},
		cread: (rel: string) =>
			readFileSync(join(dir, ".obsidian", ...rel.split("/")), "utf8"),
	};
}

describe.skipIf(!haveCreds)("config-dir sync (live)", () => {
	it("config bootstrap on A, pull on B, edit on B back to A", async () => {
		const setupClient = new NotionClient({
			token: token!,
			request: realRequest({ n: 0 }),
		});
		const container = await setupClient.request<{ id: string }>(
			"POST",
			"/pages",
			{
				parent: { page_id: userRoot },
				properties: {
					title: { title: [{ text: { content: "nhs-m5-cfg" } }] },
				},
			},
		);
		const rootId = container.id;
		const a = liveDevice(rootId, "a");
		const b = liveDevice(rootId, "b");
		try {
			// (a): A has config files → B pulls them, reload flagged
			a.cwrite("appearance.json", '{"baseFontSize":16}\n');
			a.cwrite("snippets/red.css", "body { color: red }\n");
			a.cwrite("hotkeys.json", "{}\n");
			const ra = await a.sync();
			expect(ra.failed).toBe(0);
			expect(a.state.configRootId).toBeTruthy();
			const rb = await b.sync();
			expect(rb.failed).toBe(0);
			expect(rb.configWritten).toBe(true);
			expect(b.cread("appearance.json")).toBe(
				a.cread("appearance.json"),
			);
			expect(b.cread("snippets/red.css")).toBe(
				a.cread("snippets/red.css"),
			);
			expect(b.cread("hotkeys.json")).toBe(a.cread("hotkeys.json"));

			// (b): edit appearance.json on B → A receives it
			b.cwrite("appearance.json", '{"baseFontSize":18}\n');
			const rb2 = await b.sync();
			expect(rb2.failed).toBe(0);
			const ra2 = await a.sync();
			expect(ra2.failed).toBe(0);
			expect(ra2.configWritten).toBe(true);
			expect(a.cread("appearance.json")).toBe(
				'{"baseFontSize":18}\n',
			);
		} finally {
			await setupClient
				.request("PATCH", `/pages/${rootId}`, { in_trash: true })
				.catch(() => undefined);
		}
	});
});
