// HTML table handling shared by both directions.
//
// The bug this module exists for: a table pasted from a web page arrives as
// ONE line (`<table><tr><td>a</td>…</table>`) or as escaped text
// (`\<table\>\<tr\>…`). Neither matched the "GFM table" detector, so the
// whole thing fell through to the plain-text path and every `<` `>` got
// escaped — which Notion stores as literal text. The table was gone from
// that point on, and every later round saw a difference and pulled.
//
// Two rules keep this honest:
//  • parse structurally (tag by tag), never by line shape;
//  • when a table cannot be parsed, emit nothing rather than escaped text —
//    losing a table is bad, but silently replacing it with `\<tr\>` soup is
//    worse because it looks like content.

export interface HtmlTable {
	/** Row-major cell text; the first row is the header row. */
	rows: string[][];
	/** True when the source table declared `header-row="true"`. */
	hasHeader: boolean;
}

/** One `<td>`/`<th>` or `<tr>` or `<table>`… tag. */
const TAG = /<\/?(table|tr|td|th)\b[^>]*>/gi;

/** A cell's own text, with nested inline markup kept as-is. */
const CELL_OPEN = /^<t[dh]\b[^>]*>/i;

/** Is this line nothing but table markup? Used to drop leaked fragments
 * (`</tr>`, `\<table\>` and friends) instead of writing them into the note.
 *
 * Only CLOSING tags and a bare `<table>` opener qualify. A line that still
 * carries cell text (`<td>A</td>`) is content — dropping it would lose data,
 * and that shape only appears inside a table, which is parsed structurally
 * before this check runs. */
export function isTableFragment(line: string): boolean {
	const t = line.trim();
	if (t === "") return false;
	// `\<table\>` — the escaped form older pushes wrote into the page
	const unescaped = t.replace(/\\(.)/g, "$1");
	if (!/^<\/?t(able|r|d|h)\b/i.test(unescaped)) return false;
	// Everything on the line must be table markup or whitespace.
	const rest = unescaped.replace(TAG, "").trim();
	if (rest !== "") return false;
	// `<td></td>` is debris; `<td>x</td>` is not.
	return !/<t[dh]\b[^>]*>\s*\S/i.test(unescaped);
}

/**
 * Parse an HTML table from a string that may be:
 *  • one line:      `<table><tr><td>a</td></tr></table>`
 *  • pretty-printed: one tag per line
 *  • escaped:       `\<table\>\<tr\>…`
 *  • partly broken:  stray `</tr>` after the real `</table>`
 *
 * Returns null when there is no `<table>` at all, so callers can fall back.
 * Text outside the outermost `<table>…</table>` is ignored — a table block in
 * Notion never carries siblings on the same line.
 */
export function parseHtmlTable(input: string): HtmlTable | null {
	// Undo the escaping the push path used to apply to STRUCTURE only.
	// `\|` must survive: inside a cell it means a literal pipe, and GFM needs
	// that backslash to keep the row from splitting.
	const text = input.replace(/\\([<>`*_~[\](){}^$])/g, "$1");
	const open = text.search(/<table\b/i);
	if (open === -1) return null;
	const closeMatch = /<\/table\s*>/i.exec(text.slice(open));
	const body =
		closeMatch === null
			? text.slice(open)
			: text.slice(open, open + closeMatch.index + closeMatch[0].length);
	const hasHeader = /<table\b[^>]*\bheader-row\s*=\s*"true"/i.test(body);

	const rows: string[][] = [];
	let current: string[] | null = null;
	let cell: string | null = null;
	let cursor = 0;
	/** Nesting level of <table>. A nested table is NOT supported by Notion,
	 * but historic data contains it — and stopping at the inner `</table>`
	 * would drop every following row of the outer table. */
	let depth = 0;

	const flushCell = (): void => {
		if (cell !== null && current !== null) {
			current.push(cell.trim());
		}
		cell = null;
	};
	const flushRow = (): void => {
		flushCell();
		if (current !== null) {
			// a row of only empty cells carries no information
			if (current.some((c) => c !== "")) rows.push(current);
		}
		current = null;
	};

	for (const m of body.matchAll(TAG)) {
		const idx = m.index ?? 0;
		const raw = m[0];
		const name = (m[1] ?? "").toLowerCase();
		const closing = raw.startsWith("</");

		// Text between tags belongs to the open cell (or is ignored).
		const between = body.slice(cursor, idx);
		if (cell !== null) cell += between;
		cursor = idx + raw.length;

		if (name === "table") {
			if (closing) {
				if (depth === 0) break; // outermost closed
				depth--;
				continue;
			}
			depth++;
			continue;
		}
		// A nested table's own <tr>/<td> describe the INNER grid. Notion does
		// not support nested tables; flattening is the only lossless option,
		// and it must not cut the outer row short — so the inner tags are
		// dropped but their text is folded into the cell that contains them.
		if (depth > 1) continue;
		if (name === "tr") {
			if (closing) flushRow();
			else {
				flushRow();
				current = [];
			}
			continue;
		}
		// td / th
		if (closing) {
			flushCell();
		} else {
			flushCell();
			cell = "";
			if (current === null) current = [];
		}
	}
	// Trailing text after the last tag still belongs to the open cell.
	if (cell !== null) cell += body.slice(cursor);
	flushRow();
	return rows.length > 0 ? { rows, hasHeader } : null;
}

/** Render rows as GFM. `null` when there is nothing to render. */
export function rowsToGfm(table: HtmlTable): string | null {
	const rows = table.rows.filter((r) => r.length > 0);
	if (rows.length === 0) return null;
	const cols = Math.max(...rows.map((r) => r.length));
	const fmt = (r: string[]): string =>
		`| ${Array.from({ length: cols }, (_, k) => r[k] ?? "").join(" | ")} |`;
	const out = [fmt(rows[0]!), `|${" --- |".repeat(cols)}`];
	for (const r of rows.slice(1)) out.push(fmt(r));
	return out.join("\n");
}

/** GFM rows → the enhanced-markdown `<table>` block Notion stores.
 * Cell text is passed through `escape` so a literal `|` survives. */
export function rowsToNotionTable(
	rows: string[][],
	escape: (cell: string) => string,
): string {
	const out = ['<table header-row="true">'];
	for (const row of rows) {
		out.push("<tr>");
		for (const cell of row) {
			out.push(`<td>${escape(cell).replace(/\|/g, "\\|")}</td>`);
		}
		out.push("</tr>");
	}
	out.push("</table>");
	return out.join("\n");
}

/** Split one GFM row (`| a | b |`) into trimmed cells. */
export function splitGfmRow(line: string): string[] {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
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
