import {
	iconForCalloutType,
	UNKNOWN_CALLOUT_ICON,
} from "./icons";
import {
	escapePlainPush,
	inlineToNotion,
	type PushInlineContext,
} from "./inline";
import type { LinkResolver } from "./links";

export interface ObsidianToNotionContext {
	links: LinkResolver;
	sourcePath: string;
}

const FENCE_START = /^(\s*)(`{3,}|~{3,})(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE_LINE = /^\s{0,3}>( ?)(.*)$/;
const CALLOUT_FIRST = /^\s{0,3}>\s*\[!([A-Za-z]+)\]([+-])?[ \t]*(.*)$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/;
const TABLE_DELIM = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const UNKNOWN_COMMENT = /^<!--\s*notion-unknown\s+(.*?)\s*-->\s*$/;

function indentOf(line: string): string {
	const m = line.match(/^[ \t]*/);
	return m ? (m[0] as string) : "";
}

function isTableStart(lines: string[], i: number): boolean {
	if (i + 1 >= lines.length) {
		return false;
	}
	return lines[i]!.includes("|") && TABLE_DELIM.test(lines[i + 1]!);
}

function startsBlock(lines: string[], i: number): boolean {
	const line = lines[i]!;
	if (line.trim() === "") {
		return true;
	}
	return (
		FENCE_START.test(line) ||
		line.trim().startsWith("$$") ||
		QUOTE_LINE.test(line) ||
		LIST_ITEM.test(line) ||
		HEADING.test(line) ||
		HR.test(line) ||
		UNKNOWN_COMMENT.test(line) ||
		isTableStart(lines, i)
	);
}

function splitTableRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) {
		s = s.slice(1);
	}
	if (s.endsWith("|") && !s.endsWith("\\|")) {
		s = s.slice(0, -1);
	}
	const cells: string[] = [];
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i] as string;
		if (c === "\\" && s[i + 1] === "|") {
			cur += "|";
			i++;
		} else if (c === "|") {
			cells.push(cur);
			cur = "";
		} else {
			cur += c;
		}
	}
	cells.push(cur);
	return cells.map((c) => c.trim());
}

function convertTable(
	lines: string[],
	i: number,
	ctx: PushInlineContext,
): { block: string; next: number } {
	const out: string[] = ['<table header-row="true">'];
	const emitRow = (line: string) => {
		out.push("<tr>");
		for (const cell of splitTableRow(line)) {
			out.push(
				`<td>${inlineToNotion(cell, ctx).replace(/\|/g, "\\|")}</td>`,
			);
		}
		out.push("</tr>");
	};
	emitRow(lines[i]!);
	let j = i + 2; // skip delimiter row
	while (j < lines.length && lines[j]!.includes("|") && lines[j]!.trim() !== "") {
		emitRow(lines[j]!);
		j++;
	}
	out.push("</table>");
	return { block: out.join("\n"), next: j };
}

function convertFence(
	lines: string[],
	i: number,
): { block: string; next: number } {
	const m = lines[i]!.match(FENCE_START) as RegExpMatchArray;
	const fence = m[2] as string;
	const lang = (m[3] as string).trim() || "plain text";
	const out = [`${fence}${lang}`];
	let j = i + 1;
	const closeRe = new RegExp(
		`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`,
	);
	while (j < lines.length && !closeRe.test(lines[j]!)) {
		out.push(lines[j]!);
		j++;
	}
	if (j < lines.length) {
		out.push(fence);
		j++;
	}
	return { block: out.join("\n"), next: j };
}

function convertMathBlock(
	lines: string[],
	i: number,
): { block: string; next: number } {
	const out = [lines[i]!.trim()];
	let j = i + 1;
	while (j < lines.length && lines[j]!.trim() !== "$$") {
		out.push(lines[j]!);
		j++;
	}
	if (j < lines.length) {
		out.push("$$");
		j++;
	}
	return { block: out.join("\n"), next: j };
}

function convertCallout(
	first: RegExpMatchArray,
	bodyLines: string[],
	ctx: PushInlineContext,
): string {
	const type = (first[1] as string).toLowerCase();
	const title = (first[3] as string).trim();
	const icon = iconForCalloutType(type);
	const bodySource = bodyLines.join("\n");
	const convertedBody =
		bodySource.trim() === ""
			? ""
			: obsidianToNotion(bodySource, {
					links: ctx.links,
					sourcePath: ctx.sourcePath,
				});

	const out: string[] = [];
	if (icon) {
		out.push(`<callout icon="${icon}">`);
		if (title !== "") {
			out.push(`\t**${inlineToNotion(title, ctx)}**`);
		}
	} else {
		out.push(`<callout icon="${UNKNOWN_CALLOUT_ICON}">`);
		const literal = `\\[!${type}\\]${title ? " " + escapePlainPush(title) : ""}`;
		out.push(`\t${literal}`);
	}
	if (convertedBody !== "") {
		for (const line of convertedBody.split("\n")) {
			out.push(`\t${line}`);
		}
	}
	out.push("</callout>");
	return out.join("\n");
}

function convertQuoteRun(
	lines: string[],
	i: number,
	ctx: PushInlineContext,
): { block: string; next: number } {
	const quoteLines: string[] = [];
	let j = i;
	while (j < lines.length && QUOTE_LINE.test(lines[j]!)) {
		const m = lines[j]!.match(QUOTE_LINE) as RegExpMatchArray;
		quoteLines.push(m[2] as string);
		j++;
	}
	const firstMatch = lines[i]!.match(CALLOUT_FIRST);
	if (firstMatch) {
		return {
			block: convertCallout(firstMatch, quoteLines.slice(1), ctx),
			next: j,
		};
	}
	const joined = quoteLines
		.map((l) => inlineToNotion(l, ctx))
		.join("<br>");
	return { block: `> ${joined}`, next: j };
}

interface ListItem {
	depth: number;
	marker: string;
	text: string;
}

function convertList(
	lines: string[],
	i: number,
	ctx: PushInlineContext,
): { block: string; next: number } {
	const items: ListItem[] = [];
	const indentStack: string[] = [""];
	let j = i;

	while (j < lines.length) {
		const line = lines[j]!;
		if (line.trim() === "") {
			break;
		}
		const m = line.match(LIST_ITEM);
		if (m) {
			const w = m[1] as string;
			let top = indentStack[indentStack.length - 1] as string;
			while (
				indentStack.length > 1 &&
				w !== top &&
				!(w.startsWith(top) && w.length > top.length)
			) {
				indentStack.pop();
				top = indentStack[indentStack.length - 1] as string;
			}
			if (w !== top) {
				indentStack.push(w);
			}
			const depth = indentStack.length - 1;
			const task = m[4] ? `${(m[4] as string).trim()} ` : "";
			items.push({
				depth,
				marker: `${m[2]} ${task}`,
				text: inlineToNotion((m[5] as string).trim(), ctx),
			});
			j++;
			continue;
		}
		// continuation line: indented deeper than the last item's marker
		const last = items[items.length - 1];
		const itemIndent = indentStack[last?.depth ?? 0];
		if (last && indentOf(line).length > (itemIndent?.length ?? 0)) {
			last.text += `<br>${inlineToNotion(line.trim(), ctx)}`;
			j++;
			continue;
		}
		break;
	}

	const out = items.map(
		(it) => `${"\t".repeat(it.depth)}${it.marker}${it.text}`,
	);
	return { block: out.join("\n"), next: j };
}

function convertParagraph(
	lines: string[],
	i: number,
	ctx: PushInlineContext,
): { block: string; next: number } {
	const parts: string[] = [];
	let j = i;
	while (j < lines.length && !startsBlock(lines, j)) {
		const stripped = lines[j]!.replace(/(\\| {2,})$/, "");
		parts.push(inlineToNotion(stripped, ctx));
		j++;
	}
	return { block: parts.join("<br>"), next: j };
}

export function obsidianToNotion(
	md: string,
	ctx: ObsidianToNotionContext,
): string {
	const pushCtx: PushInlineContext = {
		links: ctx.links,
		sourcePath: ctx.sourcePath,
	};
	const lines = md.replace(/\r\n/g, "\n").split("\n");
	const blocks: string[] = [];
	let i = 0;

	// Frontmatter
	if (lines[0] === "---") {
		let j = 1;
		while (j < lines.length && lines[j] !== "---") {
			j++;
		}
		if (j < lines.length) {
			const yaml = lines.slice(1, j);
			blocks.push(
				[
					"<details>",
					"<summary>📋 Properties</summary>",
					"\t```yaml",
					...yaml,
					"\t```",
					"</details>",
				].join("\n"),
			);
			i = j + 1;
		}
	}

	while (i < lines.length) {
		const line = lines[i]!;
		if (line.trim() === "") {
			i++;
			continue;
		}
		let result: { block: string; next: number };
		if (FENCE_START.test(line)) {
			result = convertFence(lines, i);
		} else if (line.trim().startsWith("$$")) {
			result = convertMathBlock(lines, i);
		} else if (isTableStart(lines, i)) {
			result = convertTable(lines, i, pushCtx);
		} else if (QUOTE_LINE.test(line)) {
			result = convertQuoteRun(lines, i, pushCtx);
		} else if (LIST_ITEM.test(line)) {
			result = convertList(lines, i, pushCtx);
		} else if (HEADING.test(line)) {
			const m = line.match(HEADING) as RegExpMatchArray;
			result = {
				block: `${m[1]} ${inlineToNotion((m[2] as string).trim(), pushCtx)}`,
				next: i + 1,
			};
		} else if (HR.test(line)) {
			result = { block: "---", next: i + 1 };
		} else {
			const unknown = line.match(UNKNOWN_COMMENT);
			if (unknown) {
				result = { block: unknown[1] as string, next: i + 1 };
			} else {
				result = convertParagraph(lines, i, pushCtx);
			}
		}
		blocks.push(result.block);
		i = result.next;
	}

	return blocks.join("\n");
}
