// Decide whether a page's rendered visible content is just a Notion-side
// re-render of the recorded source (drift) rather than a real edit.
// Both forms go through the same lossy conversion, so render drift
// converges while a human Notion-UI edit stays detectable.

import { notionToObsidian } from "../convert/notion-to-obsidian";
import { obsidianToNotion } from "../convert/obsidian-to-notion";
import { normalizeMarkdown } from "../convert/normalize";
import type { LinkResolver } from "../convert/links";
import { merge3Text } from "../engine/merge3";
import { decidePullContent, type SplitResult } from "./toggle";

export function renderMatchesSource(
	sourceBytes: Uint8Array,
	visible: string,
	links: LinkResolver,
	sourcePath?: string,
): boolean {
	const srcText = new TextDecoder().decode(sourceBytes);
	const expected = normalizeMarkdown(
		notionToObsidian(
			obsidianToNotion(srcText, { links, sourcePath: sourcePath ?? "" }),
			{ links },
		),
	);
	const current = normalizeMarkdown(notionToObsidian(visible, { links }));
	return expected === current;
}

/** The one place a pull decides what text becomes the local note.
 *
 * 1. visSha still matches → the recorded source is authoritative.
 * 2. visSha drifted but the render is unchanged → still drift, keep source.
 * 3. A human edited the page in Notion AND we still know the source:
 *    three-way merge — base = the lossy render the source would produce,
 *    ours = the lossless source, theirs = the edited render. The human's
 *    line-level edits land on the source, so Obsidian-only syntax on
 *    untouched lines survives instead of being flattened by the lossy
 *    conversion. A dirty merge falls through rather than writing
 *    conflict markers into the note.
 * 4. Fallback: plain lossy conversion of the visible render.
 */
export function pullTextFromSplit(
	split: SplitResult,
	visSha: string,
	links: LinkResolver,
	sourcePath?: string,
): Uint8Array {
	const decision = decidePullContent(split, visSha);
	if (decision.kind === "source") {
		return decision.bytes;
	}
	const sourceBytes = split.source?.bytes;
	if (sourceBytes) {
		if (renderMatchesSource(sourceBytes, split.visible, links, sourcePath)) {
			return sourceBytes;
		}
		const src = new TextDecoder().decode(sourceBytes);
		const expected = normalizeMarkdown(
			notionToObsidian(
				obsidianToNotion(src, {
					links,
					sourcePath: sourcePath ?? "",
				}),
				{ links },
			),
		);
		const current = normalizeMarkdown(
			notionToObsidian(split.visible, { links }),
		);
		const merged = merge3Text(expected, src, current);
		if (merged.clean) {
			return new TextEncoder().encode(merged.text);
		}
	}
	return new TextEncoder().encode(
		notionToObsidian(split.visible, { links }),
	);
}
