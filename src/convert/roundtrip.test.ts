import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { obsidianToNotion } from "./obsidian-to-notion";
import { notionToObsidian } from "./notion-to-obsidian";
import { fakeLinks } from "../../test-support/fake-links";

const CORPUS = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"probe",
	"corpus",
);

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

/**
 * Per-case accepted differences: a transform applied to the normalized
 * input producing the expected output. Each entry needs a reason.
 */
const ALLOWED: Record<string, { reason: string; fix: (s: string) => string }> = {
	"03-lists-spaces": {
		reason: "list indent normalized to tabs; list groups join without blank line",
		fix: (s) =>
			s
				.replace(/^ {4}- /gm, "\t\t- ")
				.replace(/^ {2}- /gm, "\t- ")
				.replace(/^ {3}(\d+\.) /gm, "\t$1 ")
				.replace("\n\n1. Numbered one", "\n1. Numbered one"),
	},
	"04-lists-tabs": {
		reason: "list groups join without blank line",
		fix: (s) => s.replace("\n\n1. Numbered one", "\n1. Numbered one"),
	},
	"05-tasks": {
		reason: "nested task indent → tab; task/bullet groups join",
		fix: (s) =>
			s
				.replace(/^ {2}- /gm, "\t- ")
				.replace("\n\n- Regular bullet", "\n- Regular bullet"),
	},
	"06-quotes": {
		reason: ">> nesting unsupported; inner > becomes literal text",
		fix: (s) => s.replace(/^>> (.*)>>$/m, "> > $1>>"),
	},
	"07-obsidian-callout": {
		reason: "fold marker dropped; title-less callout keeps [!tip] line",
		fix: (s) => s.replace("> [!warning]-", "> [!warning]"),
	},
	"10-table": {
		reason: "column alignment lost in <table> form",
		fix: (s) => s.replace("|:-----|:---:|-----:|", "| --- | --- | --- |"),
	},
	"12-embeds": {
		reason: "embeds escaped as literals until M3; \\! survives unescape",
		fix: (s) =>
			s
				.replace("![[image.png]]", "\\![[image.png]]")
				.replace("![[image.png|300]]", "\\![[image.png|300]]")
				.replace("![[Other note]]", "\\![[Other note]]")
				.replace("![[pic.jpg|100x50]]", "\\![[pic.jpg|100x50]]"),
	},
	"13-md-links-images": {
		reason: "autolink becomes [u](u) which pulls back as a bare url",
		fix: (s) =>
			s.replace(
				"<https://example.com/path?q=1>",
				"https://example.com/path?q=1",
			),
	},
	"14-inline-format": {
		reason: "lone underscores get escaped on pull",
		fix: (s) =>
			s.replace("_underscore italic_", "\\_underscore italic\\_"),
	},
	"17-html": {
		reason:
			"<br> becomes a real newline; inline colour HTML is normalized " +
			"to Notion's span syntax (style=\"color:red\" → color=\"red\") so it " +
			"renders as a real colour instead of literal text",
		fix: (s) =>
			s
				.replace(
					'Line with <br> a break and <u>underline</u>.',
					"Line with\n a break and <u>underline</u>.",
				)
				.replace(
					'<span style="color:red">',
					'<span color="red">',
				),
	},
	"18-special-chars": {
		reason: "exact round-trip offline; live adds Notion escapes like 5\\$ (accepted)",
		fix: (s) => s,
	},
	"20-hr-breaks": {
		reason: "*** and ___ normalize to ---; hard-break markers dropped",
		fix: (s) =>
			s
				.replace("***", "---")
				.replace("___", "---")
				.replace("hard break.  ", "hard break.")
				.replace("backslash\\\n", "backslash\n"),
	},
};

describe("offline round-trip", () => {
	const files = readdirSync(CORPUS)
		.filter((f) => f.endsWith(".md"))
		.sort();
	for (const file of files) {
		const caseName = file.replace(/\.md$/, "");
		it(caseName, () => {
			const input = readFileSync(join(CORPUS, file), "utf8");
			const pushed = obsidianToNotion(input, {
				links: fakeLinks,
				sourcePath: `${caseName}.md`,
			});
			const pulled = normalize(
				notionToObsidian(pushed, { links: fakeLinks }),
			);
			const allowed = ALLOWED[caseName];
			const expected = normalize(
				allowed ? allowed.fix(normalize(input)) : input,
			);
			expect(
				pulled,
				allowed
					? `differs beyond allowed (${allowed.reason})`
					: "unexpected diff",
			).toBe(expected);
		});
	}
});
