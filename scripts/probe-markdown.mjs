#!/usr/bin/env node
// Probe: send each probe/corpus/*.md file to Notion's markdown page-create
// endpoint, fetch back the normalized markdown, save outputs to probe/out/.
// Node built-ins only; run with `npm run probe`.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS_DIR = join(ROOT, "probe", "corpus");
const OUT_DIR = join(ROOT, "probe", "out");
const ENV_PATH = join(ROOT, ".env.local");
const BASE_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const MIN_INTERVAL_MS = 400;
const MAX_RETRIES = 4;

function loadEnv(path) {
	const env = {};
	if (!existsSync(path)) return env;
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
		if (m && !line.trimStart().startsWith("#")) {
			env[m[1]] = m[2].replace(/^["']|["']$/g, "");
		}
	}
	return env;
}

function parseNotionId(input) {
	const trimmed = input.trim();
	let path = trimmed;
	try {
		path = new URL(trimmed).pathname;
	} catch {
		// not a URL; scan raw string
	}
	const matches = path.match(/[0-9a-fA-F]{32}/g);
	const hex = matches?.[matches.length - 1];
	if (!hex) return null;
	const h = hex.toLowerCase();
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const env = { ...process.env, ...loadEnv(ENV_PATH) };
const token = env.NOTION_TOKEN;
const rootPage = parseNotionId(env.NOTION_ROOT_PAGE ?? "");
if (!token || !rootPage) {
	console.error("error: create .env.local with NOTION_TOKEN and NOTION_ROOT_PAGE");
	process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastRequest = -Infinity;

async function api(method, path, body) {
	for (let attempt = 0; ; attempt++) {
		const wait = MIN_INTERVAL_MS - (Date.now() - lastRequest);
		if (wait > 0) await sleep(wait);
		lastRequest = Date.now();

		let res;
		try {
			res = await fetch(`${BASE_URL}${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					"Notion-Version": NOTION_VERSION,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (err) {
			if (attempt < MAX_RETRIES) {
				await sleep(1000 * 2 ** attempt);
				continue;
			}
			throw err;
		}

		if (res.status === 429 && attempt < MAX_RETRIES) {
			const ra = Number(res.headers.get("retry-after"));
			await sleep(Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 1000 * 2 ** attempt);
			continue;
		}
		if (res.status >= 500 && attempt < MAX_RETRIES) {
			await sleep(1000 * 2 ** attempt);
			continue;
		}
		let json = null;
		try {
			json = await res.json();
		} catch {
			json = null;
		}
		return { status: res.status, json };
	}
}

const files = readdirSync(CORPUS_DIR)
	.filter((f) => f.endsWith(".md"))
	.sort();

mkdirSync(OUT_DIR, { recursive: true });
const timestamp = new Date().toISOString();
const rows = [];

for (const file of files) {
	const caseName = basename(file, ".md");
	const input = readFileSync(join(CORPUS_DIR, file), "utf8");
	const row = {
		case: caseName,
		create: "-",
		identical: "-",
		truncated: "-",
		warnings: 0,
		unknown: 0,
	};

	let pageId = null;
	try {
		const create = await api("POST", "/pages", {
			parent: { page_id: rootPage },
			properties: {
				title: {
					title: [
						{ text: { content: `nhs-probe ${caseName} ${timestamp}` } },
					],
				},
			},
			markdown: input,
		});
		row.create = String(create.status);
		if (create.status < 200 || create.status >= 300) {
			writeFileSync(
				join(OUT_DIR, `${caseName}.json`),
				JSON.stringify({ create }, null, 2),
			);
			rows.push(row);
			continue;
		}
		pageId = create.json?.id ?? null;

		const got = await api("GET", `/pages/${pageId}/markdown`);
		const markdown = got.json?.markdown ?? null;
		if (typeof markdown === "string") {
			writeFileSync(join(OUT_DIR, `${caseName}.notion.md`), markdown);
			row.identical = markdown === input ? "yes" : "no";
		}
		row.truncated = String(got.json?.truncated ?? "-");
		row.warnings = Array.isArray(got.json?.warnings)
			? got.json.warnings.length
			: 0;
		row.unknown = Array.isArray(got.json?.unknown_block_ids)
			? got.json.unknown_block_ids.length
			: 0;
		writeFileSync(
			join(OUT_DIR, `${caseName}.json`),
			JSON.stringify(
				{
					create_status: create.status,
					create_warnings: create.json?.warnings ?? null,
					get: got,
				},
				null,
				2,
			),
		);
	} catch (err) {
		row.create = `error: ${err.message}`;
		writeFileSync(
			join(OUT_DIR, `${caseName}.json`),
			JSON.stringify({ error: String(err?.stack ?? err) }, null, 2),
		);
	} finally {
		if (pageId) {
			await api("PATCH", `/pages/${pageId}`, { in_trash: true });
		}
	}
	rows.push(row);
}

const header = "| case | create | identical | truncated | warnings | unknown_blocks |";
const sep = "|---|---|---|---|---|---|";
const lines = rows.map(
	(r) =>
		`| ${r.case} | ${r.create} | ${r.identical} | ${r.truncated} | ${r.warnings} | ${r.unknown} |`,
);
const table = [header, sep, ...lines].join("\n");
console.log(`\n${table}\n`);
writeFileSync(join(OUT_DIR, "SUMMARY.md"), `# Probe summary\n\nRun: ${timestamp}\n\n${table}\n`);
