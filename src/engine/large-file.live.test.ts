// Live large-file test: a 25 MiB file uploads via multi-part and comes
// back byte-identical on the other device. Fresh container, trashed at end.

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
	const dir = mkdtempSync(join(tmpdir(), `nhs-big-${label}-`));
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
		deviceId: `${label}big-0000-4000-8000-000000000000`,
		history: {
			enabled: false, // >20 MiB versions are skipped anyway
			intervalMinutes: 0,
			maxVersions: 50,
			retentionDays: 30,
		},
		baseStore: new BaseStore(nodeTextIO(dir), ".nhs"),
		engine: { fullAuditHours: 6, roundRobinPerRound: 10 },
		configIO: new NodeConfigIO(dir),
		configSync: { ...defaultConfigSync(), enabled: false },
		selfId: "notion-hub-sync",
		isMobile: false,
	};
	return {
		dir,
		deps,
		counter,
		sync: async (): Promise<SyncReport> => {
			const t0 = Date.now();
			counter.n = 0;
			const r = await runSync(deps, { full: false });
			console.log(
				`    [${label}] sync ${Date.now() - t0}ms, ${counter.n} requests, ` +
					`report=${JSON.stringify({ c: r.created, u: r.updated, f: r.failed, b: r.blocked })}`,
			);
			return r;
		},
	};
}

describe.skipIf(!haveCreds)("large file multi-part (live)", () => {
	it("25 MiB file uploads multi-part and downloads byte-identical", async () => {
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
					title: { title: [{ text: { content: "nhs-m6-big" } }] },
				},
			},
		);
		const rootId = container.id;
		const a = liveDevice(rootId, "a");
		const b = liveDevice(rootId, "b");
		try {
			const size = 25 * 1024 * 1024;
			const bytes = Buffer.alloc(size);
			for (let i = 0; i < size; i += 65536) {
				bytes.writeUInt32LE(i, i); // cheap deterministic pseudo-randomness
			}
			writeFileSync(join(a.dir, "big.zip"), bytes);

			const ra = await a.sync();
			expect(ra.failed).toBe(0);
			expect(ra.blocked).toEqual([]);

			const rb = await b.sync();
			expect(rb.failed).toBe(0);
			const back = readFileSync(join(b.dir, "big.zip"));
			expect(back.length).toBe(size);
			expect(back.equals(bytes)).toBe(true);
		} finally {
			await setupClient
				.request("PATCH", `/pages/${rootId}`, { in_trash: true })
				.catch(() => undefined);
		}
	}, 600_000);
});
