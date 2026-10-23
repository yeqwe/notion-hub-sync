import { extractPageId, toHex32, type LinkResolver } from "./links";

export interface PushInlineContext {
	links: LinkResolver;
	sourcePath: string;
}

export interface PullInlineContext {
	links: LinkResolver;
}

const ASCII_PUNCT = /[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/;

interface Segment {
	protected: boolean;
	text: string;
}

/**
 * Split text into code spans / inline math (passed through untouched) and
 * everything else.
 */
function splitProtected(text: string): Segment[] {
	const re = /(`+)(.+?)\1|(\$[^$\n]+\$)/g;
	const out: Segment[] = [];
	let last = 0;
	for (const m of text.matchAll(re)) {
		const idx = m.index ?? 0;
		if (idx > last) {
			out.push({ protected: false, text: text.slice(last, idx) });
		}
		out.push({ protected: true, text: m[0] });
		last = idx + m[0].length;
	}
	if (last < text.length) {
		out.push({ protected: false, text: text.slice(last) });
	}
	return out;
}

/** Escape `<`, `>`, `{`, `}`; handle backslash rules (push direction). */
export function escapePlainPush(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		if (c === "\\") {
			const next = text[i + 1];
			if (next !== undefined && ASCII_PUNCT.test(next)) {
				out += "\\" + next;
				i++;
			} else if (next !== undefined) {
				out += "\\\\" + next;
				i++;
			} else {
				out += "\\\\";
			}
		} else if (c === "<" && text.startsWith("<br>", i)) {
			out += "<br>";
			i += 3;
		} else if (c === "<" || c === ">" || c === "{" || c === "}") {
			out += "\\" + c;
		} else {
			out += c;
		}
	}
	return out;
}

/** Escape a string so it renders as literal text (for unresolved links). */
function escapeLiteral(text: string): string {
	let out = "";
	for (const ch of text) {
		if ("\\[]|<>{}!".includes(ch)) {
			out += "\\" + ch;
		} else {
			out += ch;
		}
	}
	return out;
}

/** Colour / underline / emphasis tags that Obsidian renders natively and
 * that must not be escaped on the way back into the vault. */
const PASSTHROUGH_HTML = /<(\/?)(span|u|mark|font|sup|sub|br)\b[^>]*>/gi;

function unescapeObsidianEscapes(text: string): string {
	return text.replace(/\\(.)/g, "$1");
}

function convertWikilink(inner: string, ctx: PushInlineContext): string {
	// split on the first UNESCAPED `|` (cells write `[[T\|alias]]`)
	let pipeIdx = -1;
	for (let i = 0; i < inner.length; i++) {
		if (inner[i] === "|" && inner[i - 1] !== "\\") {
			pipeIdx = i;
			break;
		}
	}
	const targetPart = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
	const alias =
		pipeIdx === -1 ? null : unescapeObsidianEscapes(inner.slice(pipeIdx + 1));
	const hashIdx = targetPart.indexOf("#");
	const target = unescapeObsidianEscapes(
		hashIdx === -1 ? targetPart : targetPart.slice(0, hashIdx),
	);
	const heading = hashIdx === -1 ? null : targetPart.slice(hashIdx + 1);

	const pageId = ctx.links.pageIdForTarget(target, ctx.sourcePath);
	if (!pageId) {
		return `\\[\\[${escapeLiteral(inner)}\\]\\]`;
	}
	const display =
		alias ?? (heading ? `${target}#${heading}` : target);
	// escape for Notion link text so `a]b` can't break the link
	const safeDisplay = escapePlainPush(display).replace(
		/[\[\]]/g,
		"\\$&",
	);
	return `[${safeDisplay}](https://app.notion.com/p/${toHex32(pageId)})`;
}

const PUSH_TOKEN =
	/!\[\[[^\]\n]*\]\]|\[\[[^\]\n]*\]\]|==[^=\n]+==|<https?:\/\/[^\s>]+>|\[\^[A-Za-z0-9_-]+\]/g;

/** Notion's inline colour vocabulary (enhanced markdown `span` attribute). */
const NOTION_COLORS = new Set([
	"gray",
	"brown",
	"orange",
	"yellow",
	"green",
	"blue",
	"purple",
	"pink",
	"red",
	"gray_bg",
	"brown_bg",
	"orange_bg",
	"yellow_bg",
	"green_bg",
	"blue_bg",
	"purple_bg",
	"pink_bg",
	"red_bg",
	"default",
]);

/** Plain CSS colour names Obsidian users type in `<font color=…>`. */
const CSS_COLOR_MAP: Record<string, string> = {
	black: "default",
	gray: "gray",
	grey: "gray",
	silver: "gray",
	brown: "brown",
	maroon: "brown",
	orange: "orange",
	yellow: "yellow",
	olive: "yellow",
	green: "green",
	lime: "green",
	teal: "blue",
	aqua: "blue",
	cyan: "blue",
	blue: "blue",
	navy: "blue",
	purple: "purple",
	violet: "purple",
	magenta: "pink",
	fuchsia: "pink",
	pink: "pink",
	red: "red",
	crimson: "red",
};

/** Palette anchors in RGB, used to snap arbitrary hex colours. */
const PALETTE_RGB: Array<[string, number, number, number]> = [
	["gray", 120, 119, 116],
	["brown", 159, 107, 83],
	["orange", 217, 115, 13],
	["yellow", 203, 145, 47],
	["green", 68, 131, 97],
	["blue", 51, 126, 169],
	["purple", 144, 101, 176],
	["pink", 193, 76, 138],
	["red", 212, 76, 71],
];

function nearestNotionColor(r: number, g: number, b: number): string {
	let best = "default";
	let bestD = Infinity;
	for (const [name, pr, pg, pb] of PALETTE_RGB) {
		const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
		if (d < bestD) {
			bestD = d;
			best = name;
		}
	}
	return best;
}

/** Nearest Notion colour for an arbitrary CSS colour value. */
function notionColorFor(raw: string): string | null {
	const v = raw.trim().toLowerCase();
	if (v === "") return null;
	if (NOTION_COLORS.has(v)) return v;
	const named = CSS_COLOR_MAP[v.replace(/\s+/g, "")];
	if (named !== undefined) return named;
	const hex = v.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
	if (hex === undefined) return null;
	const full =
		hex.length === 3
			? hex
					.split("")
					.map((c) => c + c)
					.join("")
			: hex;
	const r = parseInt(full.slice(0, 2), 16);
	const g = parseInt(full.slice(2, 4), 16);
	const b = parseInt(full.slice(4, 6), 16);
	return nearestNotionColor(r, g, b);
}

/** HTML tags Obsidian/plugins emit that map onto Notion rich text. */
const INLINE_HTML =
	/^<(span|font|u|mark|strong|b|em|i|del|s|ins)(\s[^>]*)?>(.*?)<\/\1>/si;

/** Convert one inline HTML styling tag into Notion enhanced markdown, or
 * null when the tag has no Notion equivalent. */
function convertInlineHtml(
	tag: string,
	attrs: string | undefined,
	body: string,
	ctx: PushInlineContext,
): string | null {
	const a = attrs ?? "";
	const inner = (): string => inlineToNotion(body, ctx);
	switch (tag.toLowerCase()) {
		case "strong":
		case "b":
			return `**${inner()}**`;
		case "em":
		case "i":
			return `*${inner()}*`;
		case "del":
		case "s":
			return `~~${inner()}~~`;
		case "u":
		case "ins":
			return `<span underline="true">${inner()}</span>`;
		case "mark": {
			const c = a.match(/color\s*=\s*["']([^"']+)["']/i)?.[1];
			const mapped = c !== undefined ? notionColorFor(c) : null;
			const bg =
				mapped === null
					? "yellow_bg"
					: mapped.endsWith("_bg")
						? mapped
						: `${mapped}_bg`;
			return `<span color="${bg}">${inner()}</span>`;
		}
		case "span": {
			// already-Notion syntax passes through untouched
			const notionColor = a.match(/color\s*=\s*["']([^"']+)["']/i)?.[1];
			const underline = /underline\s*=\s*["']?true["']?/i.test(a);
			if (notionColor !== undefined && NOTION_COLORS.has(notionColor)) {
				return `<span color="${notionColor}">${inner()}</span>`;
			}
			if (underline) {
				return `<span underline="true">${inner()}</span>`;
			}
			// <span style="color:…">
			const styleColor = a.match(/color\s*:\s*([^;"']+)/i)?.[1];
			if (styleColor !== undefined) {
				const c = notionColorFor(styleColor);
				if (c !== null) return `<span color="${c}">${inner()}</span>`;
			}
			// <span class="text-red"> / cm-color-red / red
			const cls = a.match(/class\s*=\s*["']([^"']*)["']/i)?.[1];
			if (cls !== undefined) {
				const m = cls.match(
					/(?:^|[\s-])(?:text-|cm-color-|color-)?([a-z]+)(?=$|[\s-])/i,
				);
				if (m) {
					const c = notionColorFor(m[1] as string);
					if (c !== null) return `<span color="${c}">${inner()}</span>`;
				}
			}
			return null;
		}
		case "font": {
			const c = a.match(/color\s*=\s*["']([^"']+)["']/i)?.[1];
			if (c !== undefined) {
				const color = notionColorFor(c);
				if (color !== null) {
					return `<span color="${color}">${inner()}</span>`;
				}
			}
			return null;
		}
		default:
			return null;
	}
}

/** Convert inline HTML tags into Notion formatting. Runs before escaping
 * so `<font color="red">…</font>` styles the text instead of showing up
 * as literal angle brackets. */
function convertHtmlPush(text: string, ctx: PushInlineContext): string {
	let out = "";
	let i = 0;
	const openTag = /<(span|font|u|mark|strong|b|em|i|del|s|ins)(\s[^>]*)?>/gi;
	while (i < text.length) {
		openTag.lastIndex = i;
		const m = openTag.exec(text);
		if (m === null) {
			out += convertPlainPush(text.slice(i), ctx);
			break;
		}
		const start = m.index;
		if (start > i) out += convertPlainPush(text.slice(i, start), ctx);
		const tag = (m[1] as string).toLowerCase();
		const rest = text.slice(start);
		const full = rest.match(INLINE_HTML);
		if (full === null || (full[1] as string).toLowerCase() !== tag) {
			// unmatched open tag: emit literally (escaped) and move on
			out += escapePlainPush(m[0]);
			i = start + m[0].length;
			continue;
		}
		const converted = convertInlineHtml(
			full[1] as string,
			full[2],
			full[3] as string,
			ctx,
		);
		out += converted ?? escapePlainPush(full[0]);
		i = start + full[0].length;
	}
	return out;
}

function convertPlainPush(text: string, ctx: PushInlineContext): string {
	let out = "";
	let last = 0;
	for (const m of text.matchAll(PUSH_TOKEN)) {
		const idx = m.index ?? 0;
		out += escapePlainPush(text.slice(last, idx));
		const tok = m[0];
		if (tok.startsWith("![[")) {
			out += `\\!\\[\\[${escapeLiteral(tok.slice(3, -2))}\\]\\]`;
		} else if (tok.startsWith("[[")) {
			out += convertWikilink(tok.slice(2, -2), ctx);
		} else if (tok.startsWith("==")) {
			out += `<span color="yellow_bg">${inlineToNotion(tok.slice(2, -2), ctx)}</span>`;
		} else if (tok.startsWith("<")) {
			const url = tok.slice(1, -1);
			out += `[${url}](${url})`;
		} else {
			// footnote reference [^id]
			out += `\\[\\^${tok.slice(2, -1)}\\]`;
		}
		last = idx + tok.length;
	}
	out += escapePlainPush(text.slice(last));
	return out;
}

/** Obsidian inline markdown → Notion enhanced markdown. */
export function inlineToNotion(text: string, ctx: PushInlineContext): string {
	return splitProtected(text)
		.map((s) => (s.protected ? s.text : convertHtmlPush(s.text, ctx)))
		.join("");
}

// ---------- pull direction ----------

interface PullOptions {
	keepEscapedPipes?: boolean;
}

/** Unescape Notion's backslash escapes (pull direction), on plain text. */
function unescapePlainPull(text: string, opts: PullOptions): string {
	// `\<` survives when followed by a letter, `/`, or `!` (likely a real
	// tag we escaped on push).
	const re = opts.keepEscapedPipes
		? /\\([[\]{}^~><])/g
		: /\\([[\]{}|^~><])/g;
	const unescaped = text.replace(re, "$1");
	// `<span color=…>` / `<u>` / `<mark>` are real Obsidian markup — never
	// leave the backslashes that render them as literal text.
	return unescaped.replace(PASSTHROUGH_HTML, (m) => m.replace(/\\/g, ""));
}

/** Escape `_` unless between two alphanumerics (snake_case stays). */
function escapeUnderscores(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i] as string;
		if (c === "_" && text[i - 1] !== "\\") {
			const prev = i > 0 ? (text[i - 1] as string) : "";
			const next = i + 1 < text.length ? (text[i + 1] as string) : "";
			const between =
				/[A-Za-z0-9]/.test(prev) && /[A-Za-z0-9]/.test(next);
			out += between ? "_" : "\\_";
		} else {
			out += c;
		}
	}
	return out;
}

const NOTION_ESCAPES = /\\([\\*~`$\[\]<>{}|^_])/g;

/** Fully unescape Notion's backslash escapes → plain text. */
function unescapeNotion(text: string): string {
	return text.replace(NOTION_ESCAPES, "$1");
}

function notionLinkToWikilink(
	text: string,
	url: string,
	ctx: PullInlineContext,
	opts: PullOptions,
): string {
	const id = extractPageId(url);
	const path = id ? ctx.links.pathForPageId(id) : null;
	if (!path) {
		// plain link: convert the display text recursively
		const shown = inlineToObsidian(text, ctx, opts);
		return text === url ? url : `[${shown}](${url})`;
	}
	const plain = unescapeNotion(text);
	const t = path.replace(/\.md$/i, "");
	const b = t.slice(t.lastIndexOf("/") + 1);
	const pipe = opts.keepEscapedPipes ? "\\|" : "|";
	if (plain === b || plain === t) {
		return `[[${t}]]`;
	}
	if (plain.startsWith(`${b}#`)) {
		return `[[${t}#${plain.slice(b.length + 1)}]]`;
	}
	if (plain.startsWith(`${t}#`)) {
		return `[[${t}#${plain.slice(t.length + 1)}]]`;
	}
	return `[[${t}${pipe}${plain}]]`;
}

const PULL_TOKEN = new RegExp(
	[
		/`\$([^`]+)`\$/.source, // literal `$x$` wrapper — see below
		/\$`([^`]+)`\$/.source,
		/<span color="([a-z_]+)">(.*?)<\/span>/.source,
		/<span underline="true">(.*?)<\/span>/.source,
		/<span[^>]*>(.*?)<\/span>/.source,
		/<mention-page url="([^"]*)">(.*?)<\/mention-page>/.source,
		/<mention-user[^>]*>(.*?)<\/mention-user>/.source,
		/<mention-date[^>]*start="([^"]*)"[^>]*\/>/.source,
		/<mention-[a-z-]+[^>]*>(.*?)<\/mention-[a-z-]+>/.source,
		/\[([^\]\n]*)\]\(([^)\s]+)\)/.source,
	].join("|"),
	"g",
);

/** Notion colour → Obsidian spelling. Yellow backgrounds are the highlight
 * shorthand; every other colour has no core Obsidian equivalent and is
 * emitted as an HTML span so it survives a round trip. */
function notionColorToObsidian(color: string, body: string): string {
	if (color === "yellow_bg") return `==${body}==`;
	if (color === "default") return body;
	return `<span color="${color}">${body}</span>`;
}

function convertPlainPull(
	text: string,
	ctx: PullInlineContext,
	opts: PullOptions,
): string {
	let out = "";
	let last = 0;
	for (const m of text.matchAll(PULL_TOKEN)) {
		const idx = m.index ?? 0;
		out += escapeUnderscores(
			unescapePlainPull(text.slice(last, idx), opts),
		);
		const tok = m[0];
		if (tok.startsWith("`$")) {
			// `` `$x`$ `` style — keep as-is
			out += tok;
		} else if (tok.startsWith("$`")) {
			out += `$${m[2]}$`;
		} else if (m[3] !== undefined) {
			// <span color="…">
			out += notionColorToObsidian(
				m[3],
				inlineToObsidian(m[4] ?? "", ctx, opts),
			);
		} else if (tok.startsWith('<span underline="true">')) {
			out += `<u>${inlineToObsidian(m[5] ?? "", ctx, opts)}</u>`;
		} else if (tok.startsWith("<span")) {
			out += inlineToObsidian(m[6] ?? "", ctx, opts);
		} else if (tok.startsWith("<mention-page")) {
			const url = m[7] ?? "";
			const title = m[8] ?? "";
			const id = extractPageId(url);
			const path = id ? ctx.links.pathForPageId(id) : null;
			out += path
				? `[[${path.replace(/\.md$/i, "")}]]`
				: `[${inlineToObsidian(title, ctx, opts)}](${url})`;
		} else if (tok.startsWith("<mention-user")) {
			out += `@${inlineToObsidian(m[9] ?? "", ctx, opts)}`;
		} else if (tok.startsWith("<mention-date")) {
			out += m[10] ?? "";
		} else if (tok.startsWith("<mention-")) {
			out += inlineToObsidian(m[11] ?? "", ctx, opts);
		} else {
			out += notionLinkToWikilink(m[12] ?? "", m[13] ?? "", ctx, opts);
		}
		last = idx + tok.length;
	}
	out += escapeUnderscores(unescapePlainPull(text.slice(last), opts));
	return out;
}

/** Notion enhanced markdown → Obsidian inline markdown. */
export function inlineToObsidian(
	text: string,
	ctx: PullInlineContext,
	opts: PullOptions = {},
): string {
	// `$x$` wrapper Notion emits for inline math → `$x$` before code
	// spans get protected.
	text = text.replace(/\$`([^`\n]+)`\$/g, "$$$1$$");
	return splitProtected(text)
		.map((s) =>
			s.protected ? s.text : convertPlainPull(s.text, ctx, opts),
		)
		.join("");
}
