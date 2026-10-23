// Live two-device test: two Node vaults + states against real Notion.
// Creates a fresh container page under the user root, trashes it at the end.

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
import { emptyState, type SyncState } from "../sync/state";
import type { SyncReport } from "../sync/deps";
import { NodeVaultIO } from "../../test-support/node-vault-io";
import { BaseStore, type TextIO } from "./base-store";
import { runSync, type EngineDeps } from "./sync";

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

interface Counter {
	n: number;
	byOp: Record<string, number>;
}

const realRequest = (counter: Counter): RequestFn => {
	return async (req) => {
		counter.n++;
		const key = `${req.method} ${new URL(req.url).pathname.replace(
			/^\/v1/,
			"",
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

interface LiveDevice {
	dir: string;
	vault: NodeVaultIO;
	state: SyncState;
	deps: EngineDeps;
	counter: Counter;
	sync(full?: boolean): Promise<SyncReport>;
	write(path: string, content: string | Buffer): void;
	read(path: string): string;
}

function liveDevice(rootId: string, label: string): LiveDevice {
	const counter: Counter = { n: 0, byOp: {} };
	const dir = mkdtempSync(join(tmpdir(), `nhs-live-${label}-`));
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
		deviceId: `${label}ive00-0000-4000-8000-000000000000`,
		history: {
			enabled: true,
			intervalMinutes: 0,
			maxVersions: 50,
			retentionDays: 30,
		},
		baseStore: new BaseStore(nodeTextIO(dir), ".nhs"),
		engine: { fullAuditHours: 6, roundRobinPerRound: 10 },
	};
	return {
		dir,
		vault,
		state,
		deps,
		counter,
		sync: async (full = false) => {
			const t0 = Date.now();
			counter.n = 0;
			counter.byOp = {};
			const r = await runSync(deps, { full });
			console.log(
				`    [${label}] sync(full=${full}) ${Date.now() - t0}ms, ` +
					`${counter.n} requests, ` +
					`report=${JSON.stringify({ c: r.created, u: r.updated, s: r.skipped, f: r.failed })}`,
			);
			for (const [k, v] of Object.entries(counter.byOp).sort()) {
				console.log(`      ${v}x ${k}`);
			}
			return r;
		},
		write: (path, content) => {
			const abs = join(dir, ...path.split("/"));
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, content);
		},
		read: (path) => readFileSync(join(dir, ...path.split("/")), "utf8"),
	};
}

describe.skipIf(!haveCreds)("engine two-device (live)", () => {
	it("scenarios 1,2,3,5,7 against real Notion", async () => {
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
					title: { title: [{ text: { content: "nhs-m4b-test" } }] },
				},
			},
		);
		const rootId = container.id;
		const a = liveDevice(rootId, "a");
		const b = liveDevice(rootId, "b");
		try {
			// scenario 1: bootstrap A, B syncs, identical trees
			a.write("Home.md", "# Home\n\nhello\n");
			mkdirSync(join(a.dir, "Sub"), { recursive: true });
			a.write("Sub/Child.md", "child body\n");
			await a.sync();
			await b.sync();
			expect(b.read("Home.md")).toBe(a.read("Home.md"));
			expect(b.read("Sub/Child.md")).toBe("child body\n");

			// idle round ≈ journal read + search
			const idle = await b.sync();
			expect(idle.created + idle.updated + idle.failed).toBe(0);

			// scenario 2: edit on A → B via journal
			a.write("Home.md", "# Home\n\nhello v2\n");
			await a.sync();
			await b.sync();
			expect(b.read("Home.md")).toBe("# Home\n\nhello v2\n");

			// scenario 3: non-overlapping edits merge both ways
			a.write("Home.md", "# Home A\n\nhello v2\n");
			b.write("Sub/Child.md", "child body\n\nB tail\n");
			await a.sync();
			await b.sync();
			await a.sync();
			expect(b.read("Home.md")).toBe("# Home A\n\nhello v2\n");
			expect(a.read("Sub/Child.md")).toBe("child body\n\nB tail\n");
			expect(b.read("Sub/Child.md")).toBe("child body\n\nB tail\n");

			// scenario 5: delete on A → B trashes locally
			await a.vault.trash("Sub/Child.md");
			await a.sync();
			await b.sync();
			expect(existsSync(join(b.dir, "Sub", "Child.md"))).toBe(false);

			// scenario 7: rename file + folder on A → B moves, no re-push
			await a.vault.rename("Home.md", "Start.md");
			a.state.renameHints = [{ from: "Home.md", to: "Start.md" }];
			await a.vault.rename("Sub", "Sub2");
			a.state.renameHints!.push({ from: "Sub", to: "Sub2" });
			await a.sync();
			b.counter.n = 0;
			b.counter.byOp = {};
			const t0 = Date.now();
			const r7 = await runSync(b.deps, { full: false });
			console.log(
				`    [b] scenario7 sync ${Date.now() - t0}ms, ${b.counter.n} requests`,
			);
			for (const [k, v] of Object.entries(b.counter.byOp).sort()) {
				console.log(`      ${v}x ${k}`);
			}
			expect(r7.failed).toBe(0);
			expect(b.read("Start.md")).toContain("hello v2");
			const patchMd = Object.entries(b.counter.byOp).filter(([k]) =>
				k.endsWith("/markdown") && k.startsWith("PATCH"),
			);
			expect(patchMd.length).toBe(0); // children not re-pushed
		} finally {
			await setupClient
				.request("PATCH", `/pages/${rootId}`, { in_trash: true })
				.catch(() => undefined);
		}
	});
});
