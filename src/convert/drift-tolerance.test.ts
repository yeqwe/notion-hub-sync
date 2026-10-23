// 关键假设检验：renderMatchesSource 的输入是「源文件的原始字节」和
// 「从 Notion 拉回的 visible」。如果两者在**缩进/空行/表格边界**上有一点点
// 不同，它就返回 false，引擎便认为「远端被人类改过」，于是拉取。
//
// 但更危险的是反向情况：如果 resume 之后写回本地的内容与源文件**完全相同**，
// 用户看到"内容没变"，而引擎每轮都重复判断为"远端变了"。
//
// 这里枚举 Notion 会做的那几种规范化，看哪些会让判定翻成 false。

import { describe, expect, it } from "vitest";
import { obsidianToNotion } from "../convert/obsidian-to-notion";
import { notionToObsidian } from "../convert/notion-to-obsidian";
import { renderMatchesSource } from "../sync/source-compare";
import type { LinkResolver } from "../convert/links";

const links: LinkResolver = {
	pageIdForTarget: () => null,
	pathForPageId: () => null,
};

/** The note shape from the user's report: a table plus prose. */
const SRC = `# 腹膜的假黏液瘤

| 项目 | 内容 |
| --- | --- |
| 年龄 | 50-70 岁 |
| 位置 | 腹膜 |

后记段落。
`;

/** Notion-side normalizations that are NOT edits. */
const NOTION_REWRITES: Record<string, (md: string) => string> = {
	"as pushed": (md) => md,
	"trailing spaces stripped": (md) =>
		md.replace(/[ \t]+$/gm, ""),
	"extra blank line after table": (md) =>
		md.replace("</table>\n", "</table>\n\n"),
	"blank line before table": (md) =>
		md.replace(/(\S)\n<table/, "$1\n\n<table"),
	"CRLF line endings": (md) => md.replace(/\n/g, "\r\n"),
	"table cells collapsed": (md) =>
		md.replace(/<td>([^<]*)<\/td>\n/g, "<td>$1</td>"),
	"attribute order changed": (md) =>
		md.replace('<table header-row="true">', '<table  header-row="true">'),
	"no trailing newline": (md) => md.replace(/\n$/, ""),
};

describe("renderMatchesSource robustness (drive-by Notion rewrites)", () => {
	const srcBytes = new TextEncoder().encode(SRC);
	const pushed = obsidianToNotion(SRC, { links, sourcePath: "a.md" });

	it("baseline: as-pushed is recognised", () => {
		expect(renderMatchesSource(srcBytes, pushed, links, "a.md")).toBe(true);
	});

	for (const [name, rewrite] of Object.entries(NOTION_REWRITES)) {
		it(`tolerates: ${name}`, () => {
			const rewritten = rewrite(pushed);
			const ok = renderMatchesSource(srcBytes, rewritten, links, "a.md");
			expect(ok, `${name} flipped the verdict → the engine pulls every round`)
				.toBe(true);
		});
	}
});

describe("what a real Notion-UI edit looks like", () => {
	const srcBytes = new TextEncoder().encode(SRC);
	const pushed = obsidianToNotion(SRC, { links, sourcePath: "a.md" });

	it("detects a changed cell (must NOT be tolerated)", () => {
		const edited = pushed.replace("<td>腹膜</td>", "<td>腹腔</td>");
		expect(renderMatchesSource(srcBytes, edited, links, "a.md")).toBe(false);
	});

	it("detects an added paragraph (must NOT be tolerated)", () => {
		const edited = pushed.replace("后记段落。", "后记段落。\n\n新增一段。");
		expect(renderMatchesSource(srcBytes, edited, links, "a.md")).toBe(false);
	});
});
