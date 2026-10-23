// 反复下载的机器复现：push → pull → push，检查每轮是否幂等。
//
// 用户的症状是「我没改过，但某个笔记每轮都被判为远端更新，拉下来内容看起来
// 没变，版本历史里那个版本还是空的」。这三件事指向同一个机制：
// 引擎判定"远端变了"，于是拉取并记录一个 pre-pull 版本，但拉取结果与本地一致，
// 所以用户看不到差异 —— 而下一轮又会重复一次。
//
// 这里逐轮模拟，找出哪一步不幂等。

import { describe, expect, it } from "vitest";
import { notionToObsidian } from "../convert/notion-to-obsidian";
import { obsidianToNotion } from "../convert/obsidian-to-notion";
import { normalizeMarkdown } from "../convert/normalize";
import { renderMatchesSource } from "../sync/source-compare";
import {
	buildSourceToggle,
	splitPageMarkdown,
	VIS_PLACEHOLDER,
	visibleHash,
} from "../sync/toggle";
import { sha256Hex } from "../sync/hashes";
import type { LinkResolver } from "../convert/links";

const links: LinkResolver = {
	pageIdForTarget: () => null,
	pathForPageId: () => null,
};

const SAMPLES: Record<string, string> = {
	"simple table": `| 项目 | 内容 |
| --- | --- |
| 年龄 | 50-70 岁 |
| 位置 | 腹膜 |
`,
	"cell with <br>": `| a | b |
| --- | --- |
| 1 | x<br>y |
`,
	"cell with escaped pipe": `| a | b |
| --- | --- |
| 1 | x \\| y |
`,
	"table then list": `| a | b |
| --- | --- |
| 1 | 2 |
- one
- two
`,
	"two adjacent tables": `| a | b |
| --- | --- |
| 1 | 2 |

| c | d |
| --- | --- |
| 3 | 4 |
`,
	"table inside quote": `> text
>
> | a | b |
> | --- | --- |
> | 1 | 2 |
`,
	"table with no blank lines around": `text
| a | b |
| --- | --- |
| 1 | 2 |
after
`,
};

/** Push a note the way the engine does: visible body + source toggle. */
async function pushOnce(src: string): Promise<string> {
	const srcBytes = new TextEncoder().encode(src);
	const srcSha = await sha256Hex(srcBytes);
	const visible = obsidianToNotion(src, { links, sourcePath: "a.md" });
	const toggle = buildSourceToggle(srcSha, VIS_PLACEHOLDER, srcBytes);
	return toggle === null ? visible : `${visible}\n${toggle}`;
}

describe("round-trip idempotency (the repeat-download bug)", () => {
	for (const [name, src] of Object.entries(SAMPLES)) {
		it(`${name}: pushing twice yields the same page bytes`, async () => {
			const page1 = await pushOnce(src);
			const split = await splitPageMarkdown(page1);
			// pull: prefer the lossless source when it matches the visible text
			const pulled =
				split.source?.bytes !== null && split.source !== null
					? new TextDecoder().decode(split.source.bytes)
					: notionToObsidian(split.visible, { links });
			expect(normalizeMarkdown(pulled)).toBe(normalizeMarkdown(src));

			const page2 = await pushOnce(pulled);
			expect(page2).toBe(page1);
		});
	}

	it("a pushed page is recognised as an unchanged render of its source", async () => {
		// This is the check `evalNote` uses to decide "no remote change".
		// If it returns false the engine pulls every round.
		for (const [name, src] of Object.entries(SAMPLES)) {
			const page = await pushOnce(src);
			const split = await splitPageMarkdown(page);
			const ok = renderMatchesSource(
				new TextEncoder().encode(src),
				split.visible,
				links,
				"a.md",
			);
			expect(ok, `${name}: renderMatchesSource`).toBe(true);
		}
	});

	it("the visible hash is stable across a round trip", async () => {
		for (const [name, src] of Object.entries(SAMPLES)) {
			const page1 = await pushOnce(src);
			const vis1 = await visibleHash(
				(await splitPageMarkdown(page1)).visible,
			);
			const pulled = notionToObsidian(
				(await splitPageMarkdown(page1)).visible,
				{ links },
			);
			const page2 = await pushOnce(pulled);
			const vis2 = await visibleHash(
				(await splitPageMarkdown(page2)).visible,
			);
			expect(vis2, `${name}: visible sha`).toBe(vis1);
		}
	});
});
