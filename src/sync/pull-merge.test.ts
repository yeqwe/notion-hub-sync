// A human edit in the Notion UI used to pull `notionToObsidian(visible)`
// for the whole note — every Obsidian-only construct on lines nobody
// touched was flattened by the lossy conversion. pullTextFromSplit must
// instead merge the edit back onto the recorded lossless source.

import { describe, expect, it } from "vitest";
import { notionToObsidian } from "../convert/notion-to-obsidian";
import { obsidianToNotion } from "../convert/obsidian-to-notion";
import type { LinkResolver } from "../convert/links";
import { pullTextFromSplit } from "./source-compare";
import { sha256Hex } from "./hashes";
import {
	buildSourceToggle,
	splitPageMarkdown,
	VIS_PLACEHOLDER,
	visibleHash,
} from "./toggle";

const links: LinkResolver = {
	pageIdForTarget: () => null,
	pathForPageId: () => null,
};

// `> [!warning]-` (foldable callout) is genuinely lossy: the round trip
// drops the fold marker (see roundtrip.test.ts "07-obsidian-callout").
const LOSSY = "> [!warning]- folded callout";
const PARA = "a normal paragraph";
const SRC = `${LOSSY}\n\n${PARA}\n`;

async function pageWith(
	source: string,
	visible: string,
): Promise<{ split: Awaited<ReturnType<typeof splitPageMarkdown>>; visSha: string }> {
	const srcBytes = new TextEncoder().encode(source);
	const srcSha = await sha256Hex(srcBytes);
	// VIS_PLACEHOLDER never equals the real visible hash, so this simulates
	// a page whose visible side no longer matches the recorded render.
	const toggle = buildSourceToggle(srcSha, VIS_PLACEHOLDER, srcBytes);
	const split = await splitPageMarkdown(`${visible}\n${toggle}`);
	return { split, visSha: await visibleHash(split.visible) };
}

describe("pullTextFromSplit", () => {
	it("merges a Notion-UI edit onto the source, keeping lossy lines", async () => {
		const rendered = obsidianToNotion(SRC, {
			links,
			sourcePath: "n.md",
		});
		// The construct really is lossy — otherwise this test proves nothing.
		const roundTrip = notionToObsidian(rendered, { links });
		expect(roundTrip).not.toBe(SRC);
		expect(roundTrip).not.toContain("[!warning]-");
		expect(rendered).toContain(PARA);

		const edited = rendered.replace(PARA, "an edited paragraph");
		expect(edited).not.toBe(rendered);
		const { split, visSha } = await pageWith(SRC, edited);

		const out = new TextDecoder().decode(
			pullTextFromSplit(split, visSha, links, "n.md"),
		);
		// untouched line keeps the Obsidian-only syntax byte-identical…
		expect(out).toContain(LOSSY);
		// …while the human's Notion-side edit is still pulled down.
		expect(out).toContain("an edited paragraph");
		expect(out).not.toContain(PARA);
	});

	it("returns the source bytes when the render is merely drifted", async () => {
		const rendered = obsidianToNotion(SRC, { links, sourcePath: "n.md" });
		// matching render, only the recorded visSha is stale
		const { split, visSha } = await pageWith(SRC, rendered);
		const out = pullTextFromSplit(split, visSha, links, "n.md");
		expect(new TextDecoder().decode(out)).toBe(SRC);
	});

	it("without a source block falls back to the plain conversion", async () => {
		const visible = obsidianToNotion(SRC, { links, sourcePath: "n.md" });
		const split = await splitPageMarkdown(visible);
		expect(split.source).toBeNull();
		const visSha = await visibleHash(split.visible);
		const out = new TextDecoder().decode(
			pullTextFromSplit(split, visSha, links),
		);
		expect(out).toBe(notionToObsidian(visible, { links }));
	});
});
