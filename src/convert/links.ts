export interface LinkResolver {
	/**
	 * Obsidian link target as written (no alias/heading), resolved relative
	 * to sourcePath → Notion page id (dashed or not) or null.
	 */
	pageIdForTarget(target: string, sourcePath: string): string | null;
	/**
	 * Notion page id (any form) → vault path like "Folder/Note.md", or null.
	 */
	pathForPageId(pageId: string): string | null;
}

const HEX_32 = /[0-9a-fA-F]{32}/g;
const DASHED_UUID =
	/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/** Extract a Notion page id from a URL or raw id; returns lowercase 32-hex. */
export function extractPageId(input: string): string | null {
	let path = input;
	try {
		path = new URL(input).pathname;
	} catch {
		// not a URL; scan the raw string
	}
	const hex = path.match(HEX_32);
	if (hex && hex.length > 0) {
		return (hex[hex.length - 1] as string).toLowerCase();
	}
	const dashed = path.match(DASHED_UUID);
	if (dashed && dashed.length > 0) {
		return (dashed[dashed.length - 1] as string)
			.toLowerCase()
			.replace(/-/g, "");
	}
	return null;
}

export function toHex32(pageId: string): string {
	return pageId.toLowerCase().replace(/-/g, "");
}
