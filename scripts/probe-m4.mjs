// M4 probe: search/trash visibility, move/rename/edit effects on
// last_edited_time and search parent. Same conventions as probe-m3:
// built-in fetch, .env.local, Notion-Version 2026-03-11, >=400ms spacing,
// 429 retry, everything under one trashed container.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "probe", "out", "m4");
const NOTION_VERSION = "2026-03-11";
const MIN_INTERVAL = 400;

function loadEnv() {
	const env = {};
	try {
		for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
			const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
			if (m && !line.trimStart().startsWith("#")) {
				env[m[1]] = m[2].replace(/^["']|["']$/g, "");
			}
		}
	} catch {}
	return env;
}

const env = loadEnv();
const TOKEN = env.NOTION_TOKEN;
const ROOT_PAGE = (() => {
	let p = (env.NOTION_ROOT_PAGE ?? "").trim();
	try { p = new URL(p).pathname; } catch {}
	const hex = p.match(/[0-9a-fA-F]{32}/g)?.pop();
	if (!hex) return null;
	const h = hex.toLowerCase();
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
})();

if (!TOKEN || !ROOT_PAGE) {
	console.error("missing NOTION_TOKEN / NOTION_ROOT_PAGE in .env.local");
	process.exit(1);
}

let lastReq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
	for (let attempt = 0; ; attempt++) {
		const wait = MIN_INTERVAL - (Date.now() - lastReq);
		if (wait > 0) await sleep(wait);
		lastReq = Date.now();
		let res;
		try {
			res = await fetch(`https://api.notion.com/v1${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				"Notion-Version": NOTION_VERSION,
				"Content-Type": "application/json",
			},
				body: body === undefined ? undefined : JSON.stringify(body),
			});
		} catch (err) {
			if (attempt < 4) {
				await sleep(1000 * 2 ** attempt);
				continue;
			}
			throw err;
		}
		const json = await res.json().catch(() => null);
		if (res.status === 429 && attempt < 6) {
			const ra = Number(res.headers.get("retry-after") ?? "1");
			await sleep(Math.max(ra * 1000, 1000));
			continue;
		}
		return { status: res.status, json };
	}
}

const results = [];
const report = (name, ok, detail) => {
	const line = `${ok ? "PASS" : ok === null ? "INFO" : "FAIL"} ${name} — ${detail}`;
	console.log(line);
	results.push(line);
};

async function createPage(parent, title, markdown) {
	const res = await api("POST", "/pages", {
		parent: { page_id: parent },
		properties: { title: { title: [{ text: { content: title } }] } },
		...(markdown ? { markdown } : {}),
	});
	return res.json?.id;
}

async function searchPages() {
	const out = [];
	let cursor;
	for (let page = 0; page < 5; page++) {
		const res = await api("POST", "/search", {
			filter: { property: "object", value: "page" },
			sort: { direction: "descending", timestamp: "last_edited_time" },
			page_size: 100,
			...(cursor ? { start_cursor: cursor } : {}),
		});
		out.push(...(res.json?.results ?? []));
		if (!res.json?.has_more) break;
		cursor = res.json?.next_cursor;
	}
	return out;
}

const ts = () => new Date().toISOString();
const container = await createPage(ROOT_PAGE, `nhs-probe-m4 ${ts()}`);
if (!container) {
	console.error("container create failed");
	process.exit(1);
}
console.log(`container: ${container}`);

try {
	// ---- check 1: search visibility of a trashed page ----
	const p1 = await createPage(container, "m4-search-victim", "victim body");
	await sleep(2000);
	let found = null;
	for (let i = 0; i < 10 && !found; i++) {
		const r = await searchPages();
		found = r.find((x) => x.id === p1) ?? null;
		if (!found) await sleep(5000);
	}
	const tAppear = found ? found.last_edited_time : null;
	report(
		"search-visibility-created",
		!!found,
		found
			? `page appears in search, in_trash=${found.in_trash}, last_edited=${tAppear}`
			: "page never appeared within ~50s",
	);
	await api("PATCH", `/pages/${p1}`, { in_trash: true });
	let after = null;
	for (let i = 0; i < 6; i++) {
		await sleep(15000);
		const r = await searchPages();
		after = r.find((x) => x.id === p1) ?? null;
		if (after === null) break; // disappeared
	}
	report(
		"search-visibility-trashed",
		after === null
			? "INFO"
			: after.in_trash === true,
		after === null
			? "trashed page no longer appears in search (~<90s)"
			: `still in search after ~90s, in_trash=${after.in_trash}`,
	);

	// ---- checks 2-4: move / rename / edit vs last_edited_time ----
	// last_edited_time is minute-rounded — all ops done back-to-back,
	// then a >60s wait crosses a minute boundary before re-reading.
	const a = await createPage(container, "m4-A", "original sentence.");
	const b = await createPage(container, "m4-B");
	const c = await createPage(container, "m4-C");
	const bBefore = (await api("GET", `/pages/${b}`)).json.last_edited_time;
	const rBefore = (await api("GET", `/pages/${c}`)).json.last_edited_time;
	const eBefore = (await api("GET", `/pages/${a}`)).json.last_edited_time;

	const mv = await api("POST", `/pages/${b}/move`, {
		parent: { type: "page_id", page_id: a },
	});
	const mvImmediate = (await api("GET", `/pages/${b}`)).json.last_edited_time;

	const rn = await api("PATCH", `/pages/${c}`, {
		properties: { title: { title: [{ text: { content: "m4-C-renamed" } }] } },
	});
	const rnImmediate = (await api("GET", `/pages/${c}`)).json.last_edited_time;

	const uc = await api("PATCH", `/pages/${a}/markdown`, {
		type: "update_content",
		update_content: {
			content_updates: [
				{ old_str: "original sentence.", new_str: "edited sentence." },
			],
		},
	});
	const ucImmediate = (await api("GET", `/pages/${a}`)).json.last_edited_time;

	console.log("waiting 150s (last_edited_time may lag)…");
	await sleep(150000);
	const bLater = (await api("GET", `/pages/${b}`)).json.last_edited_time;
	const cLater = (await api("GET", `/pages/${c}`)).json.last_edited_time;
	const aLater = (await api("GET", `/pages/${a}`)).json.last_edited_time;
	const sr = await searchPages();
	const bSearch = sr.find((x) => x.id === b);

	report(
		"move-bumps-last_edited",
		mv.status === 200 && bBefore !== bLater,
		`move status=${mv.status}; B last_edited ${bBefore} → immediate ${mvImmediate} → +150s ${bLater}; ` +
			`search shows B under parent=${bSearch?.parent?.page_id ?? "(not indexed yet)"} (a=${a})`,
	);
	report(
		"rename-bumps-last_edited",
		rn.status === 200 && rBefore !== cLater,
		`rename status=${rn.status}; C last_edited ${rBefore} → immediate ${rnImmediate} → +150s ${cLater}`,
	);
	report(
		"edit-bumps-last_edited",
		uc.status === 200 && eBefore !== aLater,
		`update_content status=${uc.status}; A ${eBefore} → immediate ${ucImmediate} → +150s ${aLater}; ` +
			`precision: ${aLater?.endsWith("000Z") ? "minute-rounded" : "sub-minute"}`,
	);
} finally {
	await api("PATCH", `/pages/${container}`, { in_trash: true });
	console.log("container trashed");
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
	join(OUT_DIR, "REPORT.md"),
	`# M4 probe report\n\nRun: ${ts()}\n\n${results.join("\n")}\n`,
);
console.log(`report: ${join(OUT_DIR, "REPORT.md")}`);
