// 从真实 Notion 页面取内容，喂给修复后的转换器，验证：
//   1. 孤立 </tr> 不再进正文
//   2. 表格内容被完整还原（而不是丢失）
//   3. 还原后的笔记重新推送，是真正的 <table> 而不是转义文本
//
// 需要 .env.local；只读 Notion，不写入。

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { notionToObsidian } from "../convert/notion-to-obsidian";
import { obsidianToNotion } from "../convert/obsidian-to-notion";
import { parseHtmlTable } from "../convert/html-table";
import type { LinkResolver } from "../convert/links";

const links: LinkResolver = {
	pageIdForTarget: () => null,
	pathForPageId: () => null,
};

const PAGE_ID = "40262671155681c9baaaf589745c0551";

function token(): string | null {
	try {
		const env = readFileSync(".env.local", "utf8");
		return env.match(/NOTION_TOKEN=(.+)/)?.[1]?.trim() ?? null;
	} catch {
		return null;
	}
}

async function fetchPageMarkdown(id: string, tok: string): Promise<string> {
	const res = await fetch(`https://api.notion.com/v1/pages/${id}/markdown`, {
		headers: {
			Authorization: `Bearer ${tok}`,
			"Notion-Version": "2026-03-11",
		},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const json = (await res.json()) as { markdown?: string };
	return json.markdown ?? "";
}

describe("real page: 腹膜的假黏液瘤", () => {
	const tok = token();

	it("no stray </tr> reaches the note body", async () => {
		if (!tok) return;
		const page = await fetchPageMarkdown(PAGE_ID, tok);
		// The page genuinely contains six such lines today.
		expect(
			page.split("\n").filter((l) => /^\s*\\?<\/tr\\?>\s*$/.test(l)),
		).toHaveLength(6);

		const note = notionToObsidian(page, { links });
		expect(note).not.toContain("</tr>");
		expect(note).not.toContain("<td>");
		expect(note).not.toContain("\\<table\\>");
	});

	it("recovers both tables instead of dropping them", async () => {
		if (!tok) return;
		const page = await fetchPageMarkdown(PAGE_ID, tok);
		const note = notionToObsidian(page, { links });

		// Table 3.02 (staging) — 4 rows including the header
		expect(note).toContain("| 分期 | 标准 |");
		expect(note).toContain("pM1a");
		expect(note).toContain("pM1c");

		// Table 3.01 (grading) — the wide one
		expect(note).toContain("腹膜黏液性肿瘤分级");
		expect(note).toContain("印戒细胞");

		// Prose around the tables survives
		expect(note).toContain("表 3.02 阑尾来源腹膜假黏液瘤的分期");
		expect(note).toContain("表 3.01 腹膜假黏液瘤的组织学分类与分级");
		expect(note).toContain("Pseudomyxoma peritonei");
	});

	it("the recovered note pushes back as real table markup", async () => {
		if (!tok) return;
		const page = await fetchPageMarkdown(PAGE_ID, tok);
		const note = notionToObsidian(page, { links });
		const pushed = obsidianToNotion(note, {
			links,
			sourcePath: "腹膜的假黏液瘤.md",
		});

		// A real table block, not escaped text.
		expect(pushed).toContain("<table header-row=\"true\">");
		expect(pushed).not.toContain("\\<table\\>");
		expect(pushed).not.toContain("\\<tr\\>");
		expect(pushed).not.toContain("\\<td\\>");

		// And pulling that back is a fixed point: no more drift, so the
		// engine stops re-downloading the note every round. The source
		// toggle is excluded — its hash changes with every push by design.
		const stripSource = (md: string): string =>
			md
				.replace(/<details>[\s\S]*?<\/details>\s*$/, "")
				.split("\n")
				.filter((l) => !l.includes("obsidian-source v1"))
				.join("\n")
				.trimEnd();
		const again = notionToObsidian(pushed, { links });
		expect(stripSource(again)).toBe(stripSource(note));
	});

	it("the page's escaped tables parse structurally", async () => {
		if (!tok) return;
		const page = await fetchPageMarkdown(PAGE_ID, tok);
		const escapedTables = page
			.split("\n")
			.filter((l) => /\\<table\\>/.test(l));
		expect(escapedTables.length).toBe(2);
		for (const line of escapedTables) {
			const parsed = parseHtmlTable(line);
			expect(parsed).not.toBeNull();
			expect(parsed!.rows.length).toBeGreaterThan(1);
		}
	});
});
