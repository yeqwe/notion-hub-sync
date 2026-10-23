import { calloutTypeForIcon, UNKNOWN_CALLOUT_ICON } from "./icons";
import { inlineToObsidian, type PullInlineContext } from "./inline";
import type { LinkResolver } from "./links";

export interface NotionToObsidianContext {
	links: LinkResolver;
}

const TRAILING_ATTRS = /\s*\{[^{}\n]*=[^{}\n]*\}\s*$/;
const FENCE = /^(`{3,}|~{3,})(.*)$/;
const LIST_ITEM = /^([-*+]|\d+[.)]) /;
const SUMMARY = /^<summary>(.*)<\/summary>\s*$/;

interface Block {
	kind:
		| "text"
		| "code"
		| "math"
		| "table"
		| "callout"
		| "details"
		| "container"
		| "unknown"
		| "empty"
		| "toc"
		| "drop";
	indent: number;
	first: string;
	inner: string[]; // child lines, one tab stripped
	icon?: string;
}

function indentOf(line: string): number {
	let n = 0;
	while (n < line.length && line[n] === "\t") {
		n++;
	}
	return n;
}

function stripOneTab(line: string): string {
	return line.startsWith("\t") ? line.slice(1) : line;
}

function attr(line: string, name: string): string | null {
	const m = line.match(new RegExp(`${name}="([^"]*)"`));
	return m ? (m[1] as string) : null;
}

/**
 * Parse Notion enhanced-markdown lines into blocks. Container blocks
 * collect everything until their close tag at the same indent and get one
 * leading tab stripped per child line. For code fences, the closing fence
 * is the first line at the opening indent that starts with the fence char
 * (content lines may be unindented).
 */
function parseBlocks(lines: string[]): Block[] {
	const blocks: Block[] = [];
	let i = 0;

	const collectUntil = (
		start: number,
		isClose: (trimmed: string) => boolean,
	): { inner: string[]; next: number } => {
		const indent = indentOf(lines[start]!);
		const inner: string[] = [];
		let j = start + 1;
		while (j < lines.length) {
			const l = lines[j]!;
			if (indentOf(l) === indent && isClose(l.trim())) {
				return { inner, next: j + 1 };
			}
			inner.push(stripOneTab(l));
			j++;
		}
		return { inner, next: j };
	};

	while (i < lines.length) {
		const line = lines[i]!;
		const trimmed = line.trim();
		const indent = indentOf(line);
		if (trimmed === "") {
			i++;
			continue;
		}

		const fence = trimmed.match(FENCE);
		if (fence) {
			const fchar = (fence[1] as string)[0] as string;
			const inner: string[] = [];
			let j = i + 1;
			while (j < lines.length) {
				const l = lines[j]!;
				if (
					indentOf(l) === indent &&
					l.trim().startsWith(fchar.repeat(3))
				) {
					break;
				}
				inner.push(l.slice(Math.min(indentOf(l), indent)));
				j++;
			}
			blocks.push({
				kind: "code",
				indent,
				first: (fence[2] as string).trim(),
				inner,
			});
			i = Math.min(j + 1, lines.length);
			continue;
		}
		if (trimmed === "$$") {
			const inner: string[] = [];
			let j = i + 1;
			while (j < lines.length && lines[j]!.trim() !== "$$") {
				inner.push(stripOneTab(lines[j]!));
				j++;
			}
			blocks.push({ kind: "math", indent, first: "", inner });
			i = j + 1;
			continue;
		}
		if (/^<table[\s>]/.test(trimmed)) {
			const { inner, next } = collectUntil(i, (t) =>
				t.startsWith("</table"),
			);
			blocks.push({ kind: "table", indent, first: "", inner });
			i = next;
			continue;
		}
		if (trimmed.startsWith("<callout")) {
			const { inner, next } = collectUntil(i, (t) =>
				t.startsWith("</callout"),
			);
			blocks.push({
				kind: "callout",
				indent,
				first: "",
				inner,
				icon: attr(trimmed, "icon") ?? "",
			});
			i = next;
			continue;
		}
		if (trimmed === "<details>") {
			const { inner, next } = collectUntil(i, (t) =>
				t.startsWith("</details"),
			);
			blocks.push({ kind: "details", indent, first: "", inner });
			i = next;
			continue;
		}
		if (trimmed === "<columns>") {
			const { inner, next } = collectUntil(i, (t) =>
				t.startsWith("</columns"),
			);
			blocks.push({ kind: "container", indent, first: "", inner });
			i = next;
			continue;
		}
		if (trimmed.startsWith("<column>")) {
			const { inner, next } = collectUntil(i, (t) =>
				t.startsWith("</column"),
			);
			blocks.push({ kind: "container", indent, first: "", inner });
			i = next;
			continue;
		}
		if (trimmed.startsWith("<synced_block")) {
			const { inner, next } = collectUntil(i, (t) =>
				t.startsWith("</synced_block"),
			);
			blocks.push({ kind: "container", indent, first: "", inner });
			i = next;
			continue;
		}
		if (
			trimmed.startsWith("<page") ||
			trimmed.startsWith("<database")
		) {
			if (trimmed.endsWith("/>") || /<\/\w+>/.test(trimmed)) {
				// self-closing or fully contained on one line
				i++;
				continue;
			}
			const tag = trimmed.match(/^<(\w+)/)?.[1] ?? "page";
			const { next } = collectUntil(i, (t) => t === `</${tag}>`);
			blocks.push({ kind: "drop", indent, first: "", inner: [] });
			i = next;
			continue;
		}
		if (trimmed.startsWith("<unknown")) {
			blocks.push({
				kind: "unknown",
				indent,
				first: trimmed,
				inner: [],
			});
			i++;
			continue;
		}
		if (trimmed === "<empty-block/>") {
			blocks.push({ kind: "empty", indent, first: "", inner: [] });
			i++;
			continue;
		}
		if (trimmed === "<table_of_contents/>") {
			blocks.push({ kind: "toc", indent, first: "", inner: [] });
			i++;
			continue;
		}

		// leaf line; children = following lines with deeper indent
		// (kept with their absolute indentation)
		const inner: string[] = [];
		let j = i + 1;
		while (
			j < lines.length &&
			lines[j]!.trim() !== "" &&
			indentOf(lines[j]!) > indent
		) {
			inner.push(lines[j]!);
			j++;
		}
		blocks.push({ kind: "text", indent, first: trimmed, inner });
		i = j;
	}
	return blocks;
}

function isListItem(block: Block): boolean {
	return block.kind === "text" && LIST_ITEM.test(block.first);
}

function renderTable(inner: string[], ctx: PullInlineContext): string {
	const rows: string[][] = [];
	let current: string[] | null = null;
	for (const raw of inner) {
		const t = raw.trim();
		if (t === "<tr>") {
			current = [];
		} else if (t.startsWith("</tr")) {
			if (current) {
				rows.push(current);
			}
			current = null;
		} else if (current && t.startsWith("<td>")) {
			const cell = t.slice(4, t.endsWith("</td>") ? -5 : undefined);
			current.push(
				inlineToObsidian(cell, ctx, { keepEscapedPipes: true }),
			);
		}
	}
	if (rows.length === 0) {
		return "";
	}
	const cols = Math.max(...rows.map((r) => r.length));
	const fmt = (r: string[]) =>
		`| ${Array.from({ length: cols }, (_, k) => r[k] ?? "").join(" | ")} |`;
	const out = [fmt(rows[0]!), `|${" --- |".repeat(cols)}`];
	for (const r of rows.slice(1)) {
		out.push(fmt(r));
	}
	return out.join("\n");
}

function renderCallout(block: Block, ctx: PullInlineContext): string {
	const children = parseBlocks(block.inner);
	let title: string | null = null;
	let type = calloutTypeForIcon(block.icon ?? "") ?? "note";

	// 📌 preserves `> [!type] Title` as its first child line.
	if (
		block.icon === UNKNOWN_CALLOUT_ICON &&
		children[0]?.kind === "text"
	) {
		const unescaped = children[0].first.replace(
			/\\([\[\]{}|^~>])/g,
			"$1",
		);
		const m = unescaped.match(/^\[!([A-Za-z]+)\][ \t]*(.*)$/);
		if (m) {
			type = (m[1] as string).toLowerCase();
			title = (m[2] as string).trim() || null;
			children.shift();
		}
	}

	if (children[0]?.kind === "text" && title === null) {
		const m = children[0].first.match(/^\*\*(.*)\*\*$/);
		if (m) {
			title = m[1] as string;
			children.shift();
		}
	}

	const body = renderBlocks(children, ctx);
	const lines = [`> [!${type}]${title ? " " + title : ""}`];
	for (const l of body.split("\n")) {
		lines.push(l === "" ? ">" : `> ${l}`);
	}
	return lines.join("\n");
}

function renderDetails(
	block: Block,
	ctx: PullInlineContext,
	isFirst: boolean,
): string {
	const children = parseBlocks(block.inner);
	const first = children[0];
	const summary =
		first?.kind === "text"
			? (first.first.match(SUMMARY)?.[1] ?? first.first)
			: "";
	const rest = children.slice(1);

	if (
		isFirst &&
		summary === "📋 Properties" &&
		rest[0]?.kind === "code" &&
		rest[0].first === "yaml"
	) {
		return ["---", ...rest[0].inner, "---"].join("\n");
	}

	const body = renderBlocks(rest, ctx);
	const lines = [`> [!note]- ${summary}`];
	for (const l of body.split("\n")) {
		lines.push(l === "" ? ">" : `> ${l}`);
	}
	return lines.join("\n");
}

function renderTextBlock(block: Block, ctx: PullInlineContext): string {
	const indent = "\t".repeat(block.indent);
	const text = inlineToObsidian(
		block.first.replace(TRAILING_ATTRS, ""),
		ctx,
	);
	let lines: string[];
	if (LIST_ITEM.test(text)) {
		const m = text.match(LIST_ITEM) as RegExpMatchArray;
		const pad = " ".repeat(m[0].length);
		lines = text
			.split("<br>")
			.map((p, k) => (k === 0 ? `${indent}${p}` : `${indent}${pad}${p}`));
	} else if (text.startsWith("> ")) {
		lines = text
			.split("<br>")
			.map((p, k) => (k === 0 ? `${indent}${p}` : `${indent}> ${p}`));
	} else {
		lines = text
			.split("<br>")
			.map((p) => `${indent}${p}`);
	}
	if (block.inner.length > 0) {
		const childText = renderBlocks(parseBlocks(block.inner), ctx);
		if (childText !== "") {
			lines.push(childText);
		}
	}
	return lines.join("\n");
}

function renderBlock(
	block: Block,
	ctx: PullInlineContext,
	isFirst: boolean,
): string | null {
	switch (block.kind) {
		case "drop":
		case "toc":
			return null;
		case "code": {
			const lang = block.first === "plain text" ? "" : block.first;
			const indent = "\t".repeat(block.indent);
			return [`${indent}\`\`\`${lang}`, ...block.inner, `${indent}\`\`\``].join(
				"\n",
			);
		}
		case "math":
			return ["$$", ...block.inner, "$$"].join("\n");
		case "table":
			return renderTable(block.inner, ctx);
		case "callout":
			return renderCallout(block, ctx);
		case "details":
			return renderDetails(block, ctx, isFirst);
		case "container":
			return renderBlocks(parseBlocks(block.inner), ctx);
		case "unknown":
			return `<!-- notion-unknown ${block.first} -->`;
		case "empty":
			return "";
		default:
			return renderTextBlock(block, ctx);
	}
}

/** Render parsed blocks; consecutive list items join with one "\n". */
function renderBlocks(blocks: Block[], ctx: PullInlineContext): string {
	let out = "";
	let prev: Block | null = null;
	let first = true;
	for (const b of blocks) {
		const chunk = renderBlock(b, ctx, first);
		if (chunk === null) {
			continue;
		}
		if (prev !== null) {
			out += isListItem(prev) && isListItem(b) ? "\n" : "\n\n";
		}
		out += chunk;
		prev = b;
		first = false;
	}
	return out;
}

export function notionToObsidian(
	md: string,
	ctx: NotionToObsidianContext,
): string {
	const pullCtx: PullInlineContext = { links: ctx.links };
	const lines = md.replace(/\r\n/g, "\n").split("\n");
	const body = renderBlocks(parseBlocks(lines), pullCtx);
	return body.replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "") + "\n";
}
