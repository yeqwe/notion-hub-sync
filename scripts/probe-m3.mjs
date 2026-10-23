#!/usr/bin/env node
// M3 probe: settle design questions for page-tree push/pull.
// Creates everything under one container page, prints PASS/FAIL per check,
// writes probe/out/m3/REPORT.md, trashes the container at the end.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "probe", "out", "m3");
const ENV_PATH = join(ROOT, ".env.local");
const BASE = "https://api.notion.com/v1";
const VERSION = "2026-03-11";
const MIN_MS = 400;
const MAX_RETRIES = 4;

// ---------- helpers ----------

function loadEnv() {
	const env = {};
	if (!existsSync(ENV_PATH)) return env;
	for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
		if (m && !line.trimStart().startsWith("#")) {
			env[m[1]] = m[2].replace(/^["']|["']$/g, "");
		}
	}
	return env;
}

function parseId(input) {
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
const rootPage = parseId(env.NOTION_ROOT_PAGE);
if (!token || !rootPage) {
	console.error("error: create .env.local with NOTION_TOKEN and NOTION_ROOT_PAGE");
	process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
let lastReq = -Infinity;

async function api(method, path, body, opts = {}) {
	for (let attempt = 0; ; attempt++) {
		const wait = MIN_MS - (Date.now() - lastReq);
		if (wait > 0) await sleep(wait);
		lastReq = Date.now();
		const headers = {
			Authorization: `Bearer ${token}`,
			"Notion-Version": VERSION,
		};
		let payload;
		if (opts.formData) {
			payload = opts.formData; // fetch sets multipart boundary
		} else {
			headers["Content-Type"] = "application/json";
			payload = body === undefined ? undefined : JSON.stringify(body);
		}
		let res;
		try {
			res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
		} catch (e) {
			if (attempt < MAX_RETRIES) {
				await sleep(1000 * 2 ** attempt);
				continue;
			}
			throw e;
		}
		if (res.status === 429 && attempt < MAX_RETRIES) {
			const ra = Number(res.headers.get("retry-after"));
			await sleep(Number.isFinite(ra) ? ra * 1000 : 1000 * 2 ** attempt);
			continue;
		}
		if (res.status >= 500 && attempt < MAX_RETRIES) {
			await sleep(1000 * 2 ** attempt);
			continue;
		}
		let json = null;
		try {
			json = await res.json();
		} catch {}
		return { status: res.status, json, headers: res.headers };
	}
}

async function createPage(parentId, title, markdown) {
	const body = {
		parent: { page_id: parentId },
		properties: { title: { title: [{ text: { content: title } }] } },
	};
	if (markdown !== undefined) body.markdown = markdown;
	return api("POST", "/pages", body);
}

async function trash(id) {
	return api("PATCH", `/pages/${id}`, { in_trash: true });
}

// ---------- report plumbing ----------

const lines = [];
const failures = [];
function report(status, name, details, raw) {
	const line = `${status} ${name} — ${details}`;
	console.log(line);
	lines.push(line);
	if (raw) {
		lines.push("```json");
		lines.push(JSON.stringify(raw, null, 2).slice(0, 4000));
		lines.push("```");
	}
	if (status === "FAIL") failures.push(line);
}
const PASS = (n, d) => report("PASS", n, d);
const FAIL = (n, d, r) => report("FAIL", n, d, r);
const INFO = (n, d) => report("INFO", n, d);

// ---------- check 1: base64 source toggle ----------

function makeText(n) {
	const pieces = [
		"ascii words and spaces ",
		"中文段落片段，含汉字。",
		"\ttabbed\t",
		"    leading spaces",
		"`back` ``ticks`` ",
		"$math$ <tag> {brace} ",
		"line\\slash ",
	];
	let s = "";
	while (Buffer.byteLength(s, "utf8") < n) {
		s += pieces[s.length % pieces.length] + "\n";
	}
	return Buffer.from(s, "utf8").subarray(0, n);
}

async function checkSourceToggle(container, size) {
	const name = `source-toggle ${size / 1000}k`;
	const orig = makeText(size);
	const b64 = orig.toString("base64");
	const wrapped = b64.replace(/(.{76})/g, "$1\n").replace(/\n$/, "");
	const summary = `🔒 obsidian-source v1 sha256:${sha256(orig)}`;
	const md = [
		"Visible paragraph.",
		"<details>",
		`<summary>${summary}</summary>`,
		"\t```plain text",
		wrapped,
		"\t```",
		"</details>",
	].join("\n");

	const create = await createPage(container, `nhs-m3-src-${size}`, md);
	if (create.status !== 200) {
		FAIL(name, `create status ${create.status}`, create.json);
		return false;
	}
	const pageId = create.json.id;
	const got = await api("GET", `/pages/${pageId}/markdown`);
	const back = got.json?.markdown ?? "";
	const truncated = got.json?.truncated;

	// extract code content inside the details block
	const det = back.match(/<details>([\s\S]*?)<\/details>/);
	let decoded = null;
	let summaryBack = null;
	if (det) {
		summaryBack = det[1].match(/<summary>(.*)<\/summary>/)?.[1];
		const fence = det[1].match(/```[^\n]*\n([\s\S]*?)\n[\t ]*```/);
		if (fence) {
			const compact = fence[1].replace(/\s+/g, "");
			try {
				decoded = Buffer.from(compact, "base64");
			} catch {}
		}
	}
	const ok =
		decoded &&
		decoded.length === orig.length &&
		sha256(decoded) === sha256(orig);
	const summaryOk = summaryBack === summary;
	if (ok && !truncated && summaryOk) {
		PASS(
			name,
			`round-trips byte-identical; md length ${back.length}; truncated=${truncated}; summary verbatim=yes`,
		);
		return true;
	}
	FAIL(
		name,
		`match=${!!ok} truncated=${truncated} mdLen=${back.length} ` +
			`summaryVerbatim=${summaryOk} (got: ${JSON.stringify(summaryBack)})`,
		{ create_status: create.status, get: got.json },
	);
	return false;
}

// ---------- check 2: replace_content with child page ----------

async function checkReplaceContent(container) {
	const name = "replace_content-with-child";
	const p = await createPage(container, "nhs-m3-P", "old body");
	if (p.status !== 200) return FAIL(name, `P create ${p.status}`, p.json);
	const pId = p.json.id;
	const c = await createPage(pId, "child");
	if (c.status !== 200) return FAIL(name, `C create ${c.status}`, c.json);
	const cId = c.json.id;

	const r1 = await api("PATCH", `/pages/${pId}/markdown`, {
		type: "replace_content",
		replace_content: { new_str: "new body" },
	});
	const e1 = `status=${r1.status} code=${r1.json?.code} msg=${JSON.stringify(r1.json?.message).slice(0, 200)}`;

	const pmd = await api("GET", `/pages/${pId}/markdown`);
	const pageLines = (pmd.json?.markdown ?? "")
		.split("\n")
		.filter((l) => l.startsWith("<page"))
		.join("\n");

	const r2 = await api("PATCH", `/pages/${pId}/markdown`, {
		type: "replace_content",
		replace_content: { new_str: `new body\n${pageLines}` },
	});
	const cCheck = await api("GET", `/pages/${cId}`);
	const pmd2 = await api("GET", `/pages/${pId}/markdown`);
	const cAlive = cCheck.status === 200 && cCheck.json?.in_trash === false;
	const hasNew = (pmd2.json?.markdown ?? "").includes("new body");

	if (r1.status !== 200 && r2.status === 200 && cAlive && hasNew) {
		PASS(
			name,
			`plain replace rejected (${e1}); retry with <page> line works, ` +
				`child alive=${cAlive}, body replaced=${hasNew}`,
		);
	} else {
		FAIL(
			name,
			`first=${e1}; retry status=${r2.status} code=${r2.json?.code} ` +
				`msg=${JSON.stringify(r2.json?.message).slice(0, 200)}; ` +
				`childAlive=${cAlive} bodyReplaced=${hasNew} pageLine=${JSON.stringify(pageLines)}`,
			{ r1: r1.json, r2: r2.json, pmd: pmd.json },
		);
	}
}

// ---------- check 3: file uploads ----------

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);
const PDF_MIN = Buffer.from(
	"%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
		"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
		"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\n" +
		"trailer<</Root 1 0 R>>\n%%EOF\n",
);

async function checkUploads(container) {
	const bin4k = randomBytes(4096);
	const cases = [
		["note.md", "text/markdown", Buffer.from("# hi\nsmall md\n"), "file"],
		["pic.png", "image/png", PNG_1X1, "image"],
		["doc.pdf", "application/pdf", PDF_MIN, "pdf"],
		["drawing.canvas", "application/json", Buffer.from('{"a":1}'), "file"],
		["drawing.canvas.txt", "text/plain", Buffer.from('{"a":1}'), "file"],
		["blob.bin", "application/octet-stream", bin4k, "file"],
		["blob.bin.txt", "text/plain", bin4k, "file"],
		["blob.bin.zip", "application/zip", bin4k, "file"],
		["noext", "text/plain", Buffer.from("small text"), "file"],
	];

	for (const [fname, ctype, data, blockType] of cases) {
		const name = `upload ${fname}`;
		const up = await api("POST", "/file_uploads", {
			filename: fname,
			content_type: ctype,
		});
		if (up.status !== 200) {
			FAIL(name, `create upload ${up.status}`, up.json);
			continue;
		}
		const upId = up.json.id;
		const fd = new FormData();
		fd.append("file", new Blob([data], { type: ctype }), fname);
		const sent = await api(
			"POST",
			`/file_uploads/${upId}/send`,
			undefined,
			{ formData: fd },
		);
		if (sent.status !== 200) {
			FAIL(name, `send ${sent.status} (create ok)`, sent.json);
			continue;
		}
		const page = await createPage(container, `nhs-m3-${fname}`);
		if (page.status !== 200) {
			FAIL(name, `page create ${page.status}`, page.json);
			continue;
		}
		const attach = await api(
			"PATCH",
			`/blocks/${page.json.id}/children`,
			{
				children: [
					{
						type: blockType,
						[blockType]: {
							type: "file_upload",
							file_upload: { id: upId },
							caption: [
								{
									type: "text",
									text: { content: fname },
								},
							],
						},
					},
				],
			},
		);
		if (attach.status !== 200) {
			FAIL(name, `attach ${attach.status} (send ok)`, attach.json);
			continue;
		}
		const kids = await api(
			"GET",
			`/blocks/${page.json.id}/children?page_size=10`,
		);
		const block = kids.json?.results?.[0];
		const bdata = block?.[block?.type];
		const storedName = bdata?.name;
		const url = bdata?.file?.url;
		let match = "n/a";
		if (url) {
			const wait = MIN_MS - (Date.now() - lastReq);
			if (wait > 0) await sleep(wait);
			lastReq = Date.now();
			const dl = await fetch(url);
			const buf = Buffer.from(await dl.arrayBuffer());
			match = sha256(buf) === sha256(data) ? "yes" : "no";
		}
		PASS(
			name,
			`create=200 send=200 attach=200 type=${block?.type} ` +
				`storedName=${JSON.stringify(storedName)} downloadMatch=${match}`,
		);
	}
}

// ---------- check 4: search metadata ----------

async function checkSearch(container, iconPageId, containerCreateTime) {
	const name = "search-metadata";
	// set emoji icon first
	const ic = await api("PATCH", `/pages/${iconPageId}`, {
		icon: { type: "emoji", emoji: "📁" },
	});
	const found = new Map();
	let iconFound = null;
	let cursor;
	for (let p = 0; p < 5; p++) {
		const body = {
			filter: { property: "object", value: "page" },
			sort: { direction: "descending", timestamp: "last_edited_time" },
			page_size: 100,
		};
		if (cursor) body.start_cursor = cursor;
		const s = await api("POST", "/search", body);
		if (s.status !== 200) {
			return FAIL(name, `search ${s.status}`, s.json);
		}
		for (const r of s.json?.results ?? []) {
			const par = r.parent?.page_id;
			if (par === container || r.id === container) {
				found.set(r.id, r);
			}
			if (r.id === iconPageId) iconFound = r;
		}
		cursor = s.json?.next_cursor;
		if (!cursor || found.size >= 3) break;
	}
	const sample = iconFound ?? [...found.values()][0];
	const fields =
		sample &&
		["icon", "parent", "in_trash", "last_edited_time"]
			.map((f) => `${f}=${f in sample ? "yes" : "no"}`)
			.join(" ");
	const secs = Math.round((Date.now() - containerCreateTime) / 1000);
	const iconOk = iconFound?.icon?.emoji === "📁" || iconFound?.icon?.type === "emoji";
	if (found.size > 0) {
		report(
			iconOk ? "PASS" : "INFO",
			name,
			`found ${found.size} container pages ~${secs}s after creation; ` +
				`fields: ${fields}; emoji icon returned=${iconOk}; ` +
				`iconPatch=${ic.status}`,
			iconOk ? undefined : { iconFound: iconFound?.icon },
		);
	} else {
		FAIL(name, `container pages not found within 5 search pages (~${secs}s)`);
	}
}

// ---------- check 5: child listing shape ----------

async function checkChildren(container) {
	const name = "child-listing";
	const kids = await api("GET", `/blocks/${container}/children?page_size=100`);
	if (kids.status !== 200) {
		return FAIL(name, `status ${kids.status}`, kids.json);
	}
	const childPages = (kids.json?.results ?? []).filter(
		(b) => b.type === "child_page",
	);
	const sample = childPages[0];
	if (sample) {
		const keys = Object.keys(sample.child_page ?? {}).join(",");
		PASS(
			name,
			`${childPages.length} child_page blocks; child_page keys: [${keys}]; ` +
				`title=${JSON.stringify(sample.child_page?.title)}; ` +
				`block-level keys: ${Object.keys(sample).join(",")}`,
		);
		lines.push("```json");
		lines.push(JSON.stringify(sample, null, 2).slice(0, 2000));
		lines.push("```");
	} else {
		FAIL(name, "no child_page blocks found");
	}
}

// ---------- check 6: move + rename ----------

async function checkMove(container) {
	const name = "move-page";
	const a = await createPage(container, "nhs-m3-A");
	const b = await createPage(container, "nhs-m3-B");
	if (a.status !== 200 || b.status !== 200) {
		return FAIL(name, "setup pages failed", { a: a.json, b: b.json });
	}
	// move A under B: try POST /pages/{id}/move then PATCH parent
	const mv = await api("POST", `/pages/${a.json.id}/move`, {
		parent: { type: "page_id", page_id: b.json.id },
	});
	let moved = "none";
	if (mv.status === 200) {
		moved = "POST /pages/{id}/move";
	} else {
		const mv2 = await api("PATCH", `/pages/${a.json.id}`, {
			parent: { type: "page_id", page_id: b.json.id },
		});
		if (mv2.status === 200) {
			moved = "PATCH /pages/{id} {parent}";
		} else {
			FAIL(
				name,
				`POST move=${mv.status} ${JSON.stringify(mv.json?.message)?.slice(0, 150)}; ` +
					`PATCH parent=${mv2.status} ${JSON.stringify(mv2.json?.message)?.slice(0, 150)}`,
				{ mv: mv.json, mv2: mv2.json },
			);
			return;
		}
	}
	const aCheck = await api("GET", `/pages/${a.json.id}`);
	const parentOk = aCheck.json?.parent?.page_id === b.json.id;
	// rename B
	const rn = await api("PATCH", `/pages/${b.json.id}`, {
		properties: {
			title: { title: [{ text: { content: "nhs-m3-B-renamed" } }] },
		},
	});
	const bCheck = await api("GET", `/pages/${b.json.id}`);
	const newTitle =
		bCheck.json?.properties?.title?.title?.[0]?.plain_text ??
		bCheck.json?.properties?.title?.title?.[0]?.text?.content;
	const rnOk = rn.status === 200 && newTitle === "nhs-m3-B-renamed";
	report(
		parentOk && rnOk ? "PASS" : "FAIL",
		name,
		`move via ${moved}, parent now B=${parentOk}; rename status=${rn.status} ` +
			`title=${JSON.stringify(newTitle)}`,
		parentOk && rnOk ? undefined : { aCheck: aCheck.json?.parent, rn: rn.json },
	);
}

// ---------- main ----------

mkdirSync(OUT_DIR, { recursive: true });
const containerCreate = Date.now();
const container = await createPage(rootPage, `nhs-probe-m3 ${new Date().toISOString()}`);
if (container.status !== 200) {
	console.error(`fatal: container create ${container.status}`, container.json);
	process.exit(1);
}
const containerId = container.json.id;
console.log(`container: ${containerId}`);

let iconPage = null;
try {
	const sizes = [150000, 40000];
	for (const s of sizes) {
		const ok = await checkSourceToggle(containerId, s);
		if (!ok && s === 150000) {
			for (const t of [100000, 60000]) {
				if (await checkSourceToggle(containerId, t)) break;
			}
		}
	}
	await checkReplaceContent(containerId);
	await checkUploads(containerId);
	const ip = await createPage(containerId, "nhs-m3-iconpage");
	iconPage = ip.status === 200 ? ip.json.id : null;
	if (iconPage) {
		await checkSearch(containerId, iconPage, containerCreate);
	}
	await checkChildren(containerId);
	await checkMove(containerId);
} finally {
	await trash(containerId);
	console.log("container trashed");
}

const md = [
	"# M3 probe report",
	"",
	`Run: ${new Date().toISOString()}`,
	"",
	...lines,
	"",
].join("\n");
writeFileSync(join(OUT_DIR, "REPORT.md"), md);
console.log(`\nwrote probe/out/m3/REPORT.md; ${failures.length} FAIL lines`);
