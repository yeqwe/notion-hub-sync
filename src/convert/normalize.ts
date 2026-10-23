/** Whitespace-insensitive markdown comparison, used to tell Notion-side
 * re-render drift from a real content change (same rules the offline
 * round-trip tests use). */
export function normalizeMarkdown(md: string): string {
	return (
		md
			.replace(/\r\n/g, "\n")
			.split("\n")
			.map((l) => l.replace(/[ \t]+$/, ""))
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.replace(/^\n+/, "")
			.replace(/\n*$/, "") + "\n"
	);
}
