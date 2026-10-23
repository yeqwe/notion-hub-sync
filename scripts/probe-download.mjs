#!/usr/bin/env node
// Probe: upload a small file, extract its signed S3 URL, time the download.
// Usage: node scripts/probe-download.mjs [sizeMiB]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://api.notion.com/v1";
const VERSION = "2026-03-11";

function loadEnv() {
	const env = {};
	const p = join(ROOT, ".env.local");
	if (!existsSync(p)) return env;
	for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
		if (m && !line.trimStart().startsWith("#")) {
			env[m[1]] = m[2].replace(/^["']|["']$/g, "");
		}
	}
	return env;
}
const env = loadEnv();
const token = env.NOTION_TOKEN;
const rootPage = (env.NOTION_ROOT_PAGE ?? "")
	.match(/[0-9a-fA-F]{32}/g)?.pop()?.toLowerCase();
if (!token || !rootPage) {
	console.log("missing creds");
	process.exit(1);
}

const api = async (method, path, body) => {
	const res = await fetch(BASE + path, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			"Notion-Version": VERSION,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json = null;
	try { json = JSON.parse(text); } catch {}
	return { status: res.status, json };
};

const sizeMiB = Number(process.argv[2] ?? 5);
const size = sizeMiB * 1024 * 1024;
const bytes = randomBytes(size);

// container
const c = await api("POST", "/pages", {
	parent: { page_id: rootPage },
	properties: { title: { title: [{ text: { content: "nhs-dlprobe" } }] } },
});
const containerId = c.json.id;
console.log("container", containerId);

try {
	// upload
	const up = await api("POST", "/file_uploads", {
		filename: "probe.zip",
		content_type: "application/zip",
	});
	console.log("create", up.status, up.json?.id ?? JSON.stringify(up.json).slice(0, 200));
	const upId = up.json.id;
	const fd = new FormData();
	fd.append("file", new Blob([bytes]), "probe.zip");
	const send = await fetch(`${BASE}/file_uploads/${upId}/send`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Notion-Version": VERSION },
		body: fd,
	});
	console.log("upload send", send.status, "id", upId);

	// attach to a file page
	const page = await api("POST", "/pages", {
		parent: { page_id: containerId },
		properties: { title: { title: [{ text: { content: "probe.zip" } }] } },
		icon: { type: "external", external: { url: "https://example.com/f.png" } },
	});
	const pageId = page.json.id;
	const att = await api("PATCH", `/blocks/${pageId}/children`, {
		children: [
			{
				type: "file",
				file: { type: "file_upload", file_upload: { id: upId } },
			},
		],
	});
	console.log("attach", att.status);

	// read children, get signed url
	const ch = await api("GET", `/blocks/${pageId}/children`);
	const block = ch.json.results?.find((b) => b.type === "file");
	const url = block?.file?.file?.url ?? block?.file?.external?.url;
	if (!block || !url) {
		console.log(
			"children:",
			JSON.stringify(ch.json?.results?.[0] ?? ch.json).slice(0, 1500),
		);
	}
	console.log("signed url host:", url ? new URL(url).host : "NONE");

	if (url) {
		writeFileSync(join(ROOT, "probe", "out", "signed-url.txt"), url);
		for (let attempt = 0; attempt < 2; attempt++) {
			const t0 = Date.now();
			try {
				const res = await fetch(url);
				const ab = await res.arrayBuffer();
				const ms = Date.now() - t0;
				console.log(
					`download ${ab.byteLength} bytes in ${ms}ms ` +
						`(${(ab.byteLength / 1048576 / (ms / 1000)).toFixed(2)} MiB/s), status ${res.status}`,
				);
			} catch (e) {
				console.log("download error after", Date.now() - t0, "ms:", e.message);
			}
		}
	}
} finally {
	await api("PATCH", `/pages/${containerId}`, { in_trash: true });
}
