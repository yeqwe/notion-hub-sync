// Table-driven merge3 tests ported from pickpen (git merge-file semantics).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { merge3Text } from "./merge3";

interface FixtureCase {
	name: string;
	base: string;
	ours: string;
	theirs: string;
	clean: boolean;
	expected?: string;
}

const fixturePath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"test-support",
	"merge3-cases.json",
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
	cases: FixtureCase[];
};

const toLines = (text: string): string[] =>
	text === "" ? [] : (text.match(/[^\n]*\n|[^\n]+/g) ?? []);

const counts = (lines: string[]): Map<string, number> => {
	const m = new Map<string, number>();
	for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
	return m;
};

describe("merge3Text edge semantics (git merge-file aligned)", () => {
	const cases: Array<[string, string, string, string, string | null]> = [
		["all empty", "", "", "", ""],
		["base empty, ours adds", "", "a\n", "", "a\n"],
		["no trailing newline", "a", "a", "a", "a"],
		["ours drops trailing newline", "a\n", "a", "a\n", "a"],
		["both make identical change", "a\n", "a\nX\n", "a\nX\n", "a\nX\n"],
		[
			"edits separated by unchanged line",
			"1\n2\n3\n4\n5\n",
			"1\n2x\n3\n4\n5\n",
			"1\n2\n3\n4x\n5\n",
			"1\n2x\n3\n4x\n5\n",
		],
		[
			"multi-line append vs edit elsewhere",
			"1\n2\n3\n",
			"1\n2\n3\n4\n5\n",
			"1\n2x\n3\n",
			"1\n2x\n3\n4\n5\n",
		],
		[
			"separated insertions",
			"a\nb\nc\n",
			"a\nX\nb\nc\n",
			"a\nb\nY\nc\n",
			"a\nX\nb\nY\nc\n",
		],
		[
			"CRLF identical addition",
			"a\r\nb\r\n",
			"a\r\nb\r\nX\r\n",
			"a\r\nb\r\nX\r\n",
			"a\r\nb\r\nX\r\n",
		],
		// conflicts (adjacent changes need an unchanged line between them)
		[
			"adjacent lines each changed",
			"1\n2\n3\n4\n5\n",
			"1\n2x\n3\n4\n5\n",
			"1\n2\n3x\n4\n5\n",
			null,
		],
		[
			"same line different edits",
			"1\n2\n3\n",
			"1\n2-local\n3\n",
			"1\n2-remote\n3\n",
			null,
		],
		["one deletes, one edits same line", "1\n2\n3\n", "1\n2x\n3\n", "1\n3\n", null],
		["both append different lines", "a\nb\n", "a\nb\nX\n", "a\nb\nY\n", null],
		[
			"same anchor different inserts",
			"a\nb\nc\n",
			"a\nb\nX\nc\n",
			"a\nb\nY\nc\n",
			null,
		],
		[
			"CRLF different appends",
			"a\r\nb\r\n",
			"a\r\nb\r\nX\r\n",
			"a\r\nb\r\nY\r\n",
			null,
		],
	];

	for (const [name, base, ours, theirs, expected] of cases) {
		it(name, () => {
			const r = merge3Text(base, ours, theirs);
			if (expected === null) {
				expect(r.clean).toBe(false);
				expect(r.conflictCount).toBeGreaterThan(0);
			} else {
				expect(r.clean).toBe(true);
				expect(r.text).toBe(expected);
			}
		});
	}
});

describe("merge3Text properties", () => {
	it("either side equal to base → other side wins (fast path)", () => {
		const base = "a\nb\nc\n";
		expect(merge3Text(base, base, "a\nX\nc\n")).toEqual({
			clean: true,
			text: "a\nX\nc\n",
			conflictCount: 0,
		});
		expect(merge3Text(base, "a\nX\nc\n", base)).toEqual({
			clean: true,
			text: "a\nX\nc\n",
			conflictCount: 0,
		});
	});

	it("identical both sides → clean", () => {
		expect(merge3Text("a\n", "z\n", "z\n")).toEqual({
			clean: true,
			text: "z\n",
			conflictCount: 0,
		});
	});

	it("swapping ours/theirs gives the same verdict", () => {
		const cases: Array<[string, string, string]> = [
			["1\n2\n3\n4\n5\n", "1\n2x\n3\n4\n5\n", "1\n2\n3\n4x\n5\n"],
			["1\n2\n3\n", "1\n2l\n3\n", "1\n2r\n3\n"],
			["a\nb\n", "a\nb\nX\n", "a\nb\nY\n"],
			["", "a\n", "b\n"],
		];
		for (const [base, ours, theirs] of cases) {
			const ab = merge3Text(base, ours, theirs);
			const ba = merge3Text(base, theirs, ours);
			expect(ba.clean).toBe(ab.clean);
			if (ab.clean) expect(ba.text).toBe(ab.text);
		}
	});

	it("clean merges never drop a side's net-new lines; EOLs preserved", () => {
		let seed = 20260924;
		const rnd = (): number => {
			seed |= 0;
			seed = (seed + 0x6d2b79f5) | 0;
			let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
		const ri = (n: number): number => Math.floor(rnd() * n);
		let cleanCount = 0;
		for (let round = 0; round < 400; round++) {
			const eol = rnd() < 0.2 ? "\r\n" : "\n";
			const baseText = Array.from(
				{ length: 2 + ri(14) },
				(_, i) => `L${i}${eol}`,
			).join("");
			const mutate = (): string => {
				const lines = toLines(baseText);
				for (let k = 0; k < 1 + ri(3); k++) {
					const op = ri(3);
					const at = ri(lines.length + 1);
					if (op === 0) lines.splice(at, 0, `N${ri(1000)}${eol}`);
					else if (op === 1 && at < lines.length) lines.splice(at, 1);
					else if (at < lines.length) lines[at] = `C${ri(1000)}${eol}`;
				}
				return lines.join("");
			};
			const baseCount = counts(toLines(baseText));
			const beyond = (text: string): Map<string, number> => {
				const c = counts(toLines(text));
				for (const [v, n] of baseCount)
					c.set(v, (c.get(v) ?? 0) - n);
				return c;
			};
			const ourText = mutate();
			const theirText = mutate();
			const r = merge3Text(baseText, ourText, theirText);
			if (!r.clean) continue;
			cleanCount++;
			const merged = r.text!;
			const mergedCount = counts(toLines(merged));
			const theirBeyond = beyond(theirText);
			for (const [v, n] of beyond(ourText)) {
				const required = Math.max(n, theirBeyond.get(v) ?? 0);
				if (required <= 0) continue;
				expect(
					mergedCount.get(v) ?? 0,
					`dropped new line: ${JSON.stringify(v)}`,
				).toBeGreaterThanOrEqual(required);
			}
			if (eol === "\r\n")
				expect(/(?<!\r)\n/.test(merged)).toBe(false);
		}
		expect(cleanCount).toBeGreaterThan(50);
	});
});

describe("merge3Text fixture (git merge-file generated)", () => {
	it(`all ${fixture.cases.length} cases match`, () => {
		let clean = 0;
		for (const c of fixture.cases) {
			const r = merge3Text(c.base, c.ours, c.theirs);
			expect(r.clean, `${c.name} clean verdict`).toBe(c.clean);
			if (c.clean) {
				expect(r.text, `${c.name} merged text`).toBe(c.expected);
				clean++;
			} else {
				expect(r.conflictCount).toBeGreaterThan(0);
			}
		}
		expect(clean).toBeGreaterThan(0);
		expect(clean).toBeLessThan(fixture.cases.length);
	});
});
