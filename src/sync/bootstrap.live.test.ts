import { describe, expect, it } from "vitest";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NotionClient, type RequestFn } from "../notion/client";
import { emptyState } from "./state";
import { pushVault } from "./push";
import { pullVault } from "./pull";
import type { SyncDeps } from "./deps";
import { NodeVaultIO } from "../../test-support/node-vault-io";
import { sha256Hex } from "./hashes";

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
	if (!hex) return null;
	const h = hex.toLowerCase();
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const env = loadEnv();
const token = env.NOTION_TOKEN;
const rootPage = parseId(env.NOTION_ROOT_PAGE ?? "");
const haveCreds = Boolean(token && rootPage);

const request: RequestFn = async (req) => {
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

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

const HOME_MD = `---
title: Home
tags: [sync]
---

# Home

Home links to [[Sub/Child]] and [[Missing]].

Embed: ![[pic.png]] — done.

> [!tip] Heads up
> Callout body.

| A | B |
|---|---|
| 1 | 2 |

REPLACE-ME original sentence.
`;

const CHILD_MD = `##### Deep heading

Underscore \\_x\\_ and _y_.

- top
  - nested two spaces
    - deep four spaces
`;

function writeFixture(dir: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "Home.md"), HOME_MD);
	mkdirSync(join(dir, "Sub"), { recursive: true });
	writeFileSync(join(dir, "Sub", "Child.md"), CHILD_MD);
	writeFileSync(join(dir, "pic.png"), PNG_1X1);
	writeFileSync(join(dir, "board.canvas"), '{"nodes":[],"edges":[]}');
	writeFileSync(join(dir, "empty.md"), "");
	mkdirSync(join(dir, "Deep", "Nest", "Leaf"), { recursive: true });
	writeFileSync(
		join(dir, "Deep", "Nest", "Leaf", "note.md"),
		"# leaf\n\ncontent\n",
	);
}

async function treeHashes(
	io: NodeVaultIO,
): Promise<Map<string, string>> {
	const { files } = await io.list();
	const map = new Map<string, string>();
	for (const f of files) {
		map.set(f.path, await sha256Hex(await io.readBinary(f.path)));
	}
	return map;
}

describe.skipIf(!haveCreds)("bootstrap e2e", () => {
	it("push → pull round-trips byte-identical; edits + skips work", async () => {
		const client = new NotionClient({
			token: token!,
			request,
			minIntervalMs: 400,
		});
		const create = await client.request<{ id: string }>(
			"POST",
			"/pages",
			{
				parent: { page_id: rootPage },
				properties: {
					title: {
						title: [
							{
								text: {
									content: `nhs-e2e ${new Date().toISOString()}`,
								},
							},
						],
					},
				},
			},
		);
		const containerId = create.id;
		const hex = containerId.replace(/-/g, "").toLowerCase();
		try {
			const dir1 = mkdtempSync(join(tmpdir(), "nhs-v1-"));
			const dir2 = mkdtempSync(join(tmpdir(), "nhs-v2-"));
			const dir3 = mkdtempSync(join(tmpdir(), "nhs-v3-"));
			writeFixture(dir1);
			const v1 = new NodeVaultIO(dir1);
			const v2 = new NodeVaultIO(dir2);
			const v3 = new NodeVaultIO(dir3);
			const state = emptyState(containerId);
			const saveState = async () => {};
			const files = new Set(
				(await v1.list()).files.map((f) => f.path),
			);
			const resolvePath = (target: string): string | null => {
				if (files.has(target)) return target;
				if (files.has(`${target}.md`)) return `${target}.md`;
				const base = target.split("/").pop() as string;
				for (const f of files) {
					if (f === `${base}.md` || f.endsWith(`/${base}.md`)) {
						return f;
					}
				}
				return null;
			};
			const deps = (): SyncDeps => ({
				vault: v1,
				client,
				state,
				saveState,
				resolvePath,
				deviceId: "e2edevice",
				log: (m) => console.log(`[e2e] ${m}`),
			});

			// push
			const pushReport = await pushVault(deps());
			console.log("push report", pushReport);
			expect(pushReport.failed).toBe(0);

			// pull into empty dir2 → byte-identical
			const pull1 = await pullVault({ ...deps(), vault: v2 });
			console.log("pull1 report", pull1);
			expect(pull1.failed).toBe(0);
			const h1 = await treeHashes(v1);
			const h2 = await treeHashes(v2);
			expect([...h2.keys()].sort()).toEqual([...h1.keys()].sort());
			for (const [p, h] of h1) {
				expect(h2.get(p), `hash mismatch ${p}`).toBe(h);
			}

			// edit Home in Notion via update_content
			const homePageId = Object.entries(state.entries).find(
				([, e]) => e.path === "Home.md",
			)![0];
			const upd = await client.request(
				"PATCH",
				`/pages/${homePageId}/markdown`,
				{
					type: "update_content",
					update_content: {
						content_updates: [
							{
								old_str: "REPLACE-ME original sentence.",
								new_str: "EDITED sentence in Notion.",
							},
						],
					},
				},
			);
			expect((upd as { markdown?: string }).markdown ?? "").toContain(
				"EDITED sentence in Notion.",
			);

			// pull into dir3 → Home reflects edit, rest identical
			const pull2 = await pullVault({ ...deps(), vault: v3 });
			expect(pull2.failed).toBe(0);
			const home3 = await v3.readText("Home.md");
			expect(home3).toContain("EDITED sentence in Notion.");
			const h3 = await treeHashes(v3);
			for (const [p, h] of h3) {
				if (p === "Home.md") continue;
				expect(h, `hash mismatch ${p}`).toBe(h1.get(p));
			}

			// push again unchanged → nothing re-pushed
			const push2 = await pushVault(deps());
			console.log("push2 report", push2);
			expect(push2.failed).toBe(0);
			expect(push2.updated).toBe(0);
			expect(push2.created).toBe(0);
		} finally {
			await client.request("PATCH", `/pages/${hex}`, { in_trash: true });
			console.log("container trashed");
		}
	});
});
