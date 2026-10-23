// 单行 HTML 表格的真实数据验证（用户样本）。
import { describe, expect, it } from "vitest";
import { parseHtmlTable, rowsToGfm, isTableFragment } from "../convert/html-table";

const REAL =
	'<table><tr><td>分期</td><td>标准</td></tr><tr><td>pM1a</td><td>腹膜表面(阑尾/阑尾系膜以外)见无细胞黏液</td></tr><tr><td>pM1b</td><td>腹膜表面(阑尾/阑尾系膜以外)见黏液性肿瘤细胞沉积</td></tr><tr><td>pM1c</td><td>黏液性肿瘤沉积至腹膜以外部位</td></tr></table>';

const ESCAPED =
	'\\<table\\>\\<tr\\>\\<td\\>分期\\</td\\>\\<td\\>标准\\</td\\>\\</tr\\>\\</table\\>';

describe("parseHtmlTable", () => {
	it("parses the one-line table from the user's vault", () => {
		const t = parseHtmlTable(REAL);
		expect(t).not.toBeNull();
		expect(t!.rows).toHaveLength(4);
		expect(t!.rows[0]).toEqual(["分期", "标准"]);
		expect(t!.rows[1]).toEqual([
			"pM1a",
			"腹膜表面(阑尾/阑尾系膜以外)见无细胞黏液",
		]);
	});

	it("parses the escaped form Notion stored", () => {
		const t = parseHtmlTable(ESCAPED);
		expect(t).not.toBeNull();
		expect(t!.rows).toEqual([["分期", "标准"]]);
	});

	it("parses pretty-printed tags", () => {
		const t = parseHtmlTable(
			[
				'<table header-row="true">',
				"<tr>",
				"<td>a</td>",
				"<td>b</td>",
				"</tr>",
				"</table>",
			].join("\n"),
		);
		expect(t!.rows).toEqual([["a", "b"]]);
		expect(t!.hasHeader).toBe(true);
	});

	it("ignores stray tags after the closing </table>", () => {
		const t = parseHtmlTable(`${REAL}\n\n</tr>\n\n</tr>\n`);
		expect(t!.rows).toHaveLength(4);
	});

	it("returns null without a table", () => {
		expect(parseHtmlTable("just text")).toBeNull();
		expect(parseHtmlTable("")).toBeNull();
	});

	it("drops a row that is entirely empty", () => {
		const t = parseHtmlTable(
			"<table><tr><td>a</td></tr><tr><td></td></tr></table>",
		);
		expect(t!.rows).toEqual([["a"]]);
	});

	it("keeps cell text that contains inline markup", () => {
		const t = parseHtmlTable(
			"<table><tr><td>**bold**</td><td><span color=\"red\">x</span></td></tr></table>",
		);
		expect(t!.rows[0]![0]).toBe("**bold**");
		expect(t!.rows[0]![1]).toContain("x");
	});
});

describe("rowsToGfm", () => {
	it("renders the user's table losslessly", () => {
		const gfm = rowsToGfm(parseHtmlTable(REAL)!)!;
		expect(gfm.split("\n")[0]).toBe("| 分期 | 标准 |");
		expect(gfm).toContain("| pM1a | 腹膜表面(阑尾/阑尾系膜以外)见无细胞黏液 |");
		expect(gfm.split("\n")).toHaveLength(5); // header + delim + 3 rows
	});

	it("pads short rows to the widest one", () => {
		const gfm = rowsToGfm({ rows: [["a", "b"], ["c"]], hasHeader: true })!;
		expect(gfm.split("\n")[2]).toBe("| c |  |");
	});
});

describe("isTableFragment", () => {
	it("recognises the junk lines the user saw", () => {
		expect(isTableFragment("</tr>")).toBe(true);
		expect(isTableFragment("</tr> ")).toBe(true);
		expect(isTableFragment("\\</tr\\>")).toBe(true);
		expect(isTableFragment("<table>")).toBe(true);
		expect(isTableFragment("<tr>")).toBe(true);
	});

	it("keeps a line that still carries content", () => {
		// a cell with text is not junk — dropping it would lose data
		expect(isTableFragment("<td>a</td>")).toBe(false);
	});

	it("does not swallow real prose", () => {
		expect(isTableFragment("这是一段文字")).toBe(false);
		expect(isTableFragment("A. 低倍视野显示大量黏液")).toBe(false);
		expect(isTableFragment("")).toBe(false);
		expect(isTableFragment("<td>a</td> 后记")).toBe(false);
	});
});
