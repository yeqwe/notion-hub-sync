import { describe, expect, it } from "vitest";
import { obsidianToNotion } from "./obsidian-to-notion";
import { notionToObsidian } from "./notion-to-obsidian";
import { fakeLinks, NOTE_ID, FOLDER_NOTE_ID } from "../../test-support/fake-links";

const push = (md: string) =>
	obsidianToNotion(md, { links: fakeLinks, sourcePath: "Folder/Sub.md" });
const pull = (md: string) => notionToObsidian(md, { links: fakeLinks });

describe("obsidianToNotion", () => {
	it("joins paragraphs and blocks without blank lines", () => {
		expect(push("a1\na2\n\nb1\n\n\nc1")).toBe("a1<br>a2\nb1\nc1");
	});

	it("converts CRLF", () => {
		expect(push("a\r\nb")).toBe("a<br>b");
	});

	it("wraps frontmatter in a details/properties block", () => {
		expect(push("---\ntitle: X\ntags: [a]\n---\n\nBody")).toBe(
			"<details>\n<summary>📋 Properties</summary>\n" +
				"\t```yaml\ntitle: X\ntags: [a]\n\t```\n</details>\nBody",
		);
	});

	it("keeps code verbatim, empty lang → plain text", () => {
		expect(push("```\n<div>{x} [[z]]\n```")).toBe(
			"```plain text\n<div>{x} [[z]]\n```",
		);
		expect(push("```ts\nlet a = 1;\n```")).toBe(
			"```ts\nlet a = 1;\n```",
		);
	});

	it("converts GFM tables to <table>", () => {
		expect(push("| A | B |\n|---|---|\n| a \\| b | c |")).toBe(
			'<table header-row="true">\n<tr>\n<td>A</td>\n<td>B</td>\n</tr>\n' +
				"<tr>\n<td>a \\| b</td>\n<td>c</td>\n</tr>\n</table>",
		);
	});

	it("converts callouts with icons and titles", () => {
		expect(push("> [!note] T\n> body\n> more")).toBe(
			'<callout icon="📝">\n\t**T**\n\tbody<br>more\n</callout>',
		);
	});

	it("drops the fold marker", () => {
		expect(push("> [!warning]-\n> x")).toBe(
			'<callout icon="⚠️">\n\tx\n</callout>',
		);
	});

	it("handles unknown callout types via 📌", () => {
		expect(push("> [!custom] My Title\n> body")).toBe(
			'<callout icon="📌">\n\t\\[!custom\\] My Title\n\tbody\n</callout>',
		);
	});

	it("joins quote lines with <br> and escapes >>", () => {
		expect(push("> q1\n> q2\n>> nested")).toBe(
			"> q1<br>q2<br>\\> nested",
		);
	});

	it("converts list indentation to tabs and keeps tasks", () => {
		expect(push("- a\n  - b\n    - c\n- [ ] t\n- [x] done")).toBe(
			"- a\n\t- b\n\t\t- c\n- [ ] t\n- [x] done",
		);
	});

	it("joins item continuation lines with <br>", () => {
		expect(push("- a\n  cont line\n- b")).toBe("- a<br>cont line\n- b");
	});

	it("keeps heading markers, collapses HRs", () => {
		expect(push("## H\n\n***\n\n___")).toBe("## H\n---\n---");
	});

	it("strips hard-break markers in paragraphs", () => {
		expect(push("a  \nb\\\nc")).toBe("a<br>b<br>c");
	});

	it("restores notion-unknown comments", () => {
		expect(push('<!-- notion-unknown <unknown url="U" alt="A"/> -->')).toBe(
			'<unknown url="U" alt="A"/>',
		);
	});

	it("resolves wikilinks to app.notion.com links", () => {
		expect(push("[[Note]]")).toBe(
			`[Note](https://app.notion.com/p/${NOTE_ID})`,
		);
		expect(push("[[Note|alias]]")).toBe(
			`[alias](https://app.notion.com/p/${NOTE_ID})`,
		);
		expect(push("[[Folder/Note#Head]]")).toBe(
			`[Folder/Note#Head](https://app.notion.com/p/${FOLDER_NOTE_ID})`,
		);
	});

	it("escapes unresolved wikilinks and embeds", () => {
		expect(push("[[Missing|a|b]]")).toBe("\\[\\[Missing\\|a\\|b\\]\\]");
		expect(push("![[img.png|300]]")).toBe("\\!\\[\\[img.png\\|300\\]\\]");
	});

	it("converts highlight, autolink, footnotes", () => {
		expect(push("==hi== <https://x.co> [^1]")).toBe(
			'<span color="yellow_bg">hi</span> [https://x.co](https://x.co) \\[\\^1\\]',
		);
	});

	it("escapes specials but keeps code spans and math untouched", () => {
		expect(push("{a} a < b `c < d` $e < f$")).toBe(
			"\\{a\\} a \\< b `c < d` $e < f$",
		);
	});

	it("handles backslash rules", () => {
		expect(push("C:\\Users\\x \\* y")).toBe(
			"C:\\\\Users\\\\x \\* y",
		);
	});
});

describe("notionToObsidian", () => {
	it("splits <br> in paragraphs and joins blocks with blanks", () => {
		expect(pull("a1<br>a2\nb1")).toBe("a1\na2\n\nb1\n");
	});

	it("splits <br> in quotes into > lines", () => {
		expect(pull("> a<br>b")).toBe("> a\n> b\n");
	});

	it("joins consecutive list items with single newlines", () => {
		expect(pull("- a\n\t- b\n- c\npara")).toBe("- a\n\t- b\n- c\n\npara\n");
	});

	it("restores callouts with title inference", () => {
		expect(pull('<callout icon="📝">\n\t**T**\n\tbody<br>more\n</callout>')).toBe(
			"> [!note] T\n> body\n> more\n",
		);
	});

	it("restores unknown-type callouts from 📌", () => {
		expect(
			pull('<callout icon="📌">\n\t\\[!custom\\] My Title\n\tbody\n</callout>'),
		).toBe("> [!custom] My Title\n> body\n");
	});

	it("maps other icons to [!note]", () => {
		expect(pull('<callout icon="🦄">\n\tx\n</callout>')).toBe(
			"> [!note]\n> x\n",
		);
	});

	it("restores frontmatter from a leading properties details", () => {
		expect(
			pull(
				"<details>\n<summary>📋 Properties</summary>\n" +
					"\t```yaml\ntitle: X\n\t```\n</details>\nBody",
			),
		).toBe("---\ntitle: X\n---\n\nBody\n");
	});

	it("converts other details blocks to foldable note callouts", () => {
		expect(pull("<details>\n<summary>S</summary>\n\tx\n</details>")).toBe(
			"> [!note]- S\n> x\n",
		);
	});

	it("converts <table> back to GFM", () => {
		expect(
			pull(
				'<table header-row="true">\n<tr>\n<td>A</td>\n<td>B</td>\n</tr>\n' +
					"<tr>\n<td>a\\|b</td>\n<td>c<br>d</td>\n</tr>\n</table>",
			),
		).toBe("| A | B |\n| --- | --- |\n| a\\|b | c<br>d |\n");
	});

	it("maps plain text fences back to bare fences", () => {
		expect(pull("```plain text\nx\n```")).toBe("```\nx\n```\n");
	});

	it("drops page/database/toc, keeps unknown as comment", () => {
		expect(
			pull(
				'<page url="u">x</page>\n<table_of_contents/>\n' +
					'<unknown url="U" alt="A"/>\n<empty-block/>',
			),
		).toBe('<!-- notion-unknown <unknown url="U" alt="A"/> -->\n');
	});

	it("unwraps math spans and highlight spans", () => {
		expect(pull("$`a^2`$ <span color=\"yellow_bg\">hi</span>")).toBe(
			"$a^2$ ==hi==\n",
		);
	});

	it("converts Notion links back to wikilinks", () => {
		expect(pull(`[Note](https://app.notion.com/p/${NOTE_ID})`)).toBe(
			"[[Note]]\n",
		);
		expect(
			pull(`[alias](https://app.notion.com/p/${NOTE_ID})`),
		).toBe("[[Note|alias]]\n");
		expect(
			pull(
				`[Note#Sec](https://app.notion.com/p/${NOTE_ID})`,
			),
		).toBe("[[Note#Sec]]\n");
	});

	it("converts mention-page/user/date", () => {
		expect(
			pull(
				`<mention-page url="https://app.notion.com/p/${NOTE_ID}">Note</mention-page>`,
			),
		).toBe("[[Note]]\n");
		expect(pull("<mention-user>U</mention-user>")).toBe("@U\n");
		expect(pull('<mention-date start="2026-01-02"/>')).toBe("2026-01-02\n");
	});

	it("unescapes Notion escapes including \\<", () => {
		expect(pull("\\[a\\] \\{b\\} \\| \\^x \\~y \\<div\\>")).toBe(
			"[a] {b} | ^x ~y <div>\n",
		);
	});

	it("escapes underscores except inside words", () => {
		expect(pull("_x_ snake_case stays")).toBe("\\_x\\_ snake_case stays\n");
	});

	it("unescapes link text before wikilink matching", () => {
		expect(
			pull(
				`[Note#\\^blockid](https://app.notion.com/p/${NOTE_ID})`,
			),
		).toBe("[[Note#^blockid]]\n");
		expect(
			pull(`[a\\_b](https://app.notion.com/p/${NOTE_ID})`),
		).toBe("[[Note|a_b]]\n");
	});

	it("converts inner text of non-wikilink links recursively", () => {
		expect(pull("[**b** \\{x\\}](https://x.co)")).toBe(
			"[**b** {x}](https://x.co)\n",
		);
	});

	it("converts span and mention contents recursively", () => {
		expect(
			pull('<span color="yellow_bg">\\{hi\\}</span>'),
		).toBe("=={hi}==\n");
		expect(
			pull('<span underline="true">a\\_b</span>'),
		).toBe("<u>a\\_b</u>\n");
		expect(pull("<span>x\\[y\\]</span>")).toBe("x[y]\n");
		expect(
			pull('<mention-user>a\\_b</mention-user>'),
		).toBe("@a\\_b\n");
	});

	it("escapes wikilink display text for Notion links", () => {
		expect(push("[[Note|a<b{c}]]")).toBe(
			`[a\\<b\\{c\\}](https://app.notion.com/p/${NOTE_ID})`,
		);
	});

	it("converts == == inner text on push", () => {
		expect(push("==a<b==")).toBe(
			'<span color="yellow_bg">a\\<b</span>',
		);
	});

	it("keeps \\| inside table-cell wikilinks on push", () => {
		expect(push("| [[Note\\|alias]] | x |\n|---|---|")).toBe(
			'<table header-row="true">\n<tr>\n' +
				`<td>[alias](https://app.notion.com/p/${NOTE_ID})</td>\n` +
				"<td>x</td>\n</tr>\n</table>",
		);
	});

	it("emits [[T\\|alias]] for wikilinks inside pulled table cells", () => {
		expect(
			pull(
				'<table header-row="true">\n<tr>\n<td>H</td>\n</tr>\n<tr>\n' +
					`<td>[alias](https://app.notion.com/p/${NOTE_ID})</td>\n</tr>\n</table>`,
			),
		).toBe("| H |\n| --- |\n| [[Note\\|alias]] |\n");
	});
});
