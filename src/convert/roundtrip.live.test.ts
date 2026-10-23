import { describe, expect, it } from "vitest";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { obsidianToNotion } from "./obsidian-to-notion";
import { notionToObsidian } from "./notion-to-obsidian";
import type { LinkResolver } from "./links";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CORPUS = join(ROOT, "probe", "corpus");
const OUT = join(ROOT, "probe", "out", "roundtrip");
const ENV_PATH = join(ROOT, ".env.local");

function loadEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	if (!existsSync(ENV_PATH)) return env;
	for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
		if (m && !line.trimStart().startsWith("#")) {
			env[m[1] as string] = (m[2] as string).replace(/^["']|["']$/g, "");
		}
	}
	return env;
}

function parseRootPage(input: string): string | null {
	let path = input.trim();
	try {
		path = new URL(path).pathname;
	} catch {
		// raw id
	}
	const hex = path.match(/[0-9a-fA-F]{32}/g)?.pop();
	if (!hex) return null;
	const h = hex.toLowerCase();
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const env = loadEnv();
const token = env.NOTION_TOKEN;
const rootPage = parseRootPage(env.NOTION_ROOT_PAGE ?? "");
const haveCreds = Boolean(token && rootPage);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastRequest = -Infinity;

async function api(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; json: any }> {
	for (let attempt = 0; ; attempt++) {
		const wait = 400 - (Date.now() - lastRequest);
		if (wait > 0) await sleep(wait);
		lastRequest = Date.now();
		const res = await fetch(`https://api.notion.com/v1${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Notion-Version": "2026-03-11",
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (res.status === 429 && attempt < 4) {
			const ra = Number(res.headers.get("retry-after"));
			await sleep(
				Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 1000 * 2 ** attempt,
			);
			continue;
		}
		if (res.status >= 500 && attempt < 4) {
			await sleep(1000 * 2 ** attempt);
			continue;
		}
		return { status: res.status, json: await res.json().catch(() => null) };
	}
}

function normalize(md: string): string {
	return (
		md
			.replace(/\r\n/g, "\n")
			.split("\n")
			.map((l) => l.replace(/[ \t]+$/, ""))
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.replace(/^\n+/, "")
			.replace(/\n*$/, "") + "\n"
	);
}

function diff(a: string, b: string): string {
	const al = a.split("\n");
	const bl = b.split("\n");
	const out: string[] = [];
	const max = Math.max(al.length, bl.length);
	for (let i = 0; i < max; i++) {
		if (al[i] === bl[i]) {
			out.push(`  ${al[i] ?? ""}`);
		} else {
			if (al[i] !== undefined) out.push(`- ${al[i]}`);
			if (bl[i] !== undefined) out.push(`+ ${bl[i]}`);
		}
	}
	return out.join("\n");
}

describe.skipIf(!haveCreds)("live round-trip", () => {
	const files = readdirSync(CORPUS)
		.filter((f) => f.endsWith(".md"))
		.sort();
	const timestamp = new Date().toISOString();
	const rows: string[] = [];

	it("runs all corpus cases", async () => {
		mkdirSync(OUT, { recursive: true });
		const links: LinkResolver = {
			pageIdForTarget: (t) => (t === "Note" ? rootPage : null),
			pathForPageId: (id) =>
				id.replace(/-/g, "").toLowerCase() ===
				rootPage!.replace(/-/g, "").toLowerCase()
					? "Note.md"
					: null,
		};

		for (const file of files) {
			const caseName = file.replace(/\.md$/, "");
			const input = readFileSync(join(CORPUS, file), "utf8");
			const pushed = obsidianToNotion(input, {
				links,
				sourcePath: `${caseName}.md`,
			});
			writeFileSync(join(OUT, `${caseName}.pushed.md`), pushed);

			const create = await api("POST", "/pages", {
				parent: { page_id: rootPage },
				properties: {
					title: {
						title: [
							{
								text: {
									content: `nhs-rt ${caseName} ${timestamp}`,
								},
							},
						],
					},
				},
				markdown: pushed,
			});
			expect(
				create.status,
				`${caseName} create: ${JSON.stringify(create.json)}`,
			).toBe(200);
			const warnings = create.json?.warnings ?? [];
			expect(warnings, `${caseName} warnings`).toEqual([]);

			const pageId = create.json.id as string;
			try {
				const got = await api("GET", `/pages/${pageId}/markdown`);
				const notionMd: string = got.json?.markdown ?? "";
				writeFileSync(join(OUT, `${caseName}.notion.md`), notionMd);

				const pulled = notionToObsidian(notionMd, { links });
				writeFileSync(join(OUT, `${caseName}.pulled.md`), pulled);

				const identical =
					normalize(pulled) === normalize(input) ? "yes" : "no";
				writeFileSync(
					join(OUT, `${caseName}.diff`),
					diff(normalize(input), normalize(pulled)),
				);
				rows.push(
					`| ${caseName} | ${create.status} | ${warnings.length} | ${identical} |`,
				);
			} finally {
				await api("PATCH", `/pages/${pageId}`, { in_trash: true });
			}
		}

		const table = [
			"| case | create | warnings | identical |",
			"|---|---|---|---|",
			...rows,
		].join("\n");
		writeFileSync(
			join(OUT, "SUMMARY.md"),
			`# Live round-trip\n\nRun: ${timestamp}\n\n${table}\n`,
		);
	});
});
