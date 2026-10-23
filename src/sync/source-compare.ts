// Decide whether a page's rendered visible content is just a Notion-side
// re-render of the recorded source (drift) rather than a real edit.
// Both forms go through the same lossy conversion, so render drift
// converges while a human Notion-UI edit stays detectable.

import { notionToObsidian } from "../convert/notion-to-obsidian";
import { obsidianToNotion } from "../convert/obsidian-to-notion";
import { normalizeMarkdown } from "../convert/normalize";
import type { LinkResolver } from "../convert/links";

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
