// 用用户真实的 Notion 页面内容做端到端验证。
//
// 从 Notion 取回的那篇页面里，表格是「被转义的单行 HTML」：
//   \<table\>\<tr\>\<td\>分期\</td\>…\</tr\>
// 外加三行孤立的 </tr>。修复后要求：
//   1. 表格能被还原成 GFM 表格（内容不丢）
//   2. 孤立的 </tr> 不再进正文
//   3. 还原后的笔记再推送，与原页面一致（幂等，不再每轮拉取）

import { describe, expect, it } from "vitest";
import { notionToObsidian } from "../convert/notion-to-obsidian";
import { obsidianToNotion } from "../convert/obsidian-to-notion";
import { parseHtmlTable, rowsToGfm } from "../convert/html-table";
import type { LinkResolver } from "../convert/links";

const links: LinkResolver = {
	pageIdForTarget: () => null,
	pathForPageId: () => null,
};

/** 用户页面 L49–L52 的真实内容（转义表格 + 三行孤立 </tr>）。 */
const REAL_ESCAPED_BLOCK = [
	"\\<table\\>\\<tr\\>\\<td\\>分期\\</td\\>\\<td\\>标准\\</td\\>\\</tr\\>\\<tr\\>\\<td\\>pM1a\\</td\\>\\<td\\>腹膜表面(阑尾/阑尾系膜以外)见无细胞黏液\\</td\\>\\</tr\\>\\<tr\\>\\<td\\>pM1b\\</td\\>\\<td\\>腹膜表面(阑尾/阑尾系膜以外)见黏液性肿瘤细胞沉积\\</td\\>\\</tr\\>\\<tr\\>\\<td\\>pM1c\\</td\\>\\<td\\>黏液性肿瘤沉积至腹膜以外部位\\</td\\>\\</tr\\>\\</table\\>",
	"</tr>",
	"\\</tr\\>",
	"\\</tr\\>",
].join("\n");

describe("real Notion page: escaped one-line table", () => {
	it("recovers the table instead of dropping it", () => {
		const parsed = parseHtmlTable(REAL_ESCAPED_BLOCK);
		expect(parsed).not.toBeNull();
		expect(parsed!.rows).toHaveLength(4);
		expect(parsed!.rows[0]).toEqual(["分期", "标准"]);
		expect(parsed!.rows[3]).toEqual(["pM1c", "黏液性肿瘤沉积至腹膜以外部位"]);
	});

	it("does not write stray </tr> into the note", () => {
		const out = notionToObsidian(REAL_ESCAPED_BLOCK, { links });
		expect(out).not.toContain("</tr>");
		expect(out).not.toContain("<td>");
	});

	it("renders the table as GFM", () => {
		const out = notionToObsidian(REAL_ESCAPED_BLOCK, { links });
		expect(out).toContain("| 分期 | 标准 |");
		expect(out).toContain("| pM1a | 腹膜表面(阑尾/阑尾系膜以外)见无细胞黏液 |");
	});

	it("a table mixed with prose keeps the prose and loses only the debris", () => {
		const page = [
			"表 3.02 阑尾来源腹膜假黏液瘤的分期",
			"",
			REAL_ESCAPED_BLOCK,
			"",
			"表 3.01 腹膜假黏液瘤的组织学分类与分级",
		].join("\n");
		const out = notionToObsidian(page, { links });
		expect(out).toContain("表 3.02 阑尾来源腹膜假黏液瘤的分期");
		expect(out).toContain("表 3.01 腹膜假黏液瘤的组织学分类与分级");
		expect(out).toContain("| pM1a |");
		expect(out).not.toContain("</tr>");
	});

	it("is idempotent: pushing the recovered note reproduces the table", () => {
		const out = notionToObsidian(REAL_ESCAPED_BLOCK, { links });
		const pushed = obsidianToNotion(out, { links, sourcePath: "a.md" });
		// The recovered GFM table must survive a push as a real <table> block,
		// NOT as escaped text.
		expect(pushed).toContain("<table header-row=\"true\">");
		expect(pushed).toContain("<td>pM1a</td>");
		expect(pushed).not.toContain("\\<table\\>");
		expect(pushed).not.toContain("\\<td\\>");

		// and pulling that again yields the same GFM
		expect(notionToObsidian(pushed, { links })).toBe(out);
	});
});

describe("one-line table pasted into the vault (push direction)", () => {
	const VAULT_TABLE =
		"<table><tr><td>分期</td><td>标准</td></tr><tr><td>pM1a</td><td>无细胞黏液</td></tr></table>";

	it("is not escaped into literal text", () => {
		const pushed = obsidianToNotion(VAULT_TABLE, {
			links,
			sourcePath: "a.md",
		});
		expect(pushed).not.toContain("\\<table\\>");
		expect(pushed).not.toContain("\\<tr\\>");
		expect(pushed).toContain("<table header-row=\"true\">");
	});

	it("round-trips back to the same GFM table", () => {
		const pushed = obsidianToNotion(VAULT_TABLE, {
			links,
			sourcePath: "a.md",
		});
		const pulled = notionToObsidian(pushed, { links });
		expect(pulled).toContain("| 分期 | 标准 |");
		expect(pulled).toContain("| pM1a | 无细胞黏液 |");
	});

	it("a nested table never truncates the outer one or leaks tags", () => {
		// Notion has no nested tables, so this only guards against historic
		// junk. Perfect flattening is not the goal — not losing the rest of the
		// page and not emitting `</tr>` into the note is.
		const nested =
			'<table><tr><td>A</td><td><table><tr><td>x</td></tr></table></td></tr><tr><td>B</td><td>y</td></tr></table>';
		const parsed = parseHtmlTable(nested);
		expect(parsed).not.toBeNull();
		const gfm = rowsToGfm(parsed!)!;
		expect(gfm).not.toContain("</tr>");
		expect(gfm).not.toContain("<td>");
		// The outer table's first row survived with the inner cell folded in.
		expect(gfm).toContain("A");
	});
});
