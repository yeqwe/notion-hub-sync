import { describe, expect, it } from "vitest";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NotionClient, type RequestFn } from "../notion/client";
import { emptyState } from "./state";
import { pushVault } from "./push";
import { pullVault } from "./pull";
import { entryByPath } from "./state";
import {
	downloadVersion,
	listVersions,
} from "./history";
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

const V1 = "# Note\n\nversion one content.\n";
const V2 = "# Note\n\nversion TWO content — edited locally.\n";
const LOCAL_OTHER = "# Note\n\nunrelated local draft.\n";

describe.skipIf(!haveCreds)("history e2e", () => {
	it("push records versions; pre-pull snapshots overwritten bytes", async () => {
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
									content: `nhs-history-e2e ${new Date().toISOString()}`,
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
			const dir1 = mkdtempSync(join(tmpdir(), "nhs-hv1-"));
			const dir2 = mkdtempSync(join(tmpdir(), "nhs-hv2-"));
			writeFileSync(join(dir1, "Note.md"), V1);
			const v1 = new NodeVaultIO(dir1);
			const v2 = new NodeVaultIO(dir2);
			const state = emptyState(containerId);
			const deps = (vault: NodeVaultIO): SyncDeps => ({
				vault,
				client,
				state,
				saveState: async () => {},
				resolvePath: () => null,
				deviceId: "e2ehistdevice",
				history: {
					enabled: true,
					intervalMinutes: 0,
					maxVersions: 50,
					retentionDays: 30,
				},
				historyPageCache: new Map(),
				log: (m) => console.log(`[e2e] ${m}`),
			});

			// push v1, edit locally, push v2 — two "push" versions
			const p1 = await pushVault(deps(v1));
			expect(p1.failed).toBe(0);
			writeFileSync(join(dir1, "Note.md"), V2);
			const p2 = await pushVault(deps(v1));
			expect(p2.failed).toBe(0);
			expect(p2.warnings).toEqual([]);

			const found = entryByPath(state, "Note.md");
			expect(found).not.toBeNull();
			const histId = found!.entry.historyPageId;
			expect(histId).toBeTruthy();
			expect(state.historyRootId).toBeTruthy();

			const { versions } = await listVersions(client, histId!);
			expect(versions.length).toBe(2);
			const [v2Sha, v1Sha] = await Promise.all([
				sha256Hex(new TextEncoder().encode(V2)),
				sha256Hex(new TextEncoder().encode(V1)),
			]);
			// newest first
			expect(versions[0]!.caption.s).toBe(v2Sha);
			expect(versions[0]!.caption.r).toBe("push");
			expect(versions[1]!.caption.s).toBe(v1Sha);
			const newestBytes = await downloadVersion(client, versions[0]!);
			expect(new TextDecoder().decode(newestBytes)).toBe(V2);

			// pull into dir2 whose local content differs → "pre-pull" version
			writeFileSync(join(dir2, "Note.md"), LOCAL_OTHER);
			const pull = await pullVault(deps(v2));
			expect(pull.failed).toBe(0);
			expect(await v2.readText("Note.md")).toBe(V2);

			const after = await listVersions(client, histId!);
			expect(after.versions.length).toBe(3);
			const top = after.versions[0]!;
			expect(top.caption.r).toBe("pre-pull");
			expect(top.caption.s).toBe(
				await sha256Hex(new TextEncoder().encode(LOCAL_OTHER)),
			);
			const prePull = await downloadVersion(client, top);
			expect(new TextDecoder().decode(prePull)).toBe(LOCAL_OTHER);
		} finally {
			await client.request("PATCH", `/pages/${hex}`, {
				in_trash: true,
			});
			console.log("container trashed");
		}
	});
});
