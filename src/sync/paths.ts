const BAD_CHARS = /[\\/:*?"<>|]/g;

export function sanitizeTitle(title: string): string {
	const s = title.replace(BAD_CHARS, "-").trim();
	return s === "" ? "Untitled" : s;
}

function splitExt(name: string): { stem: string; ext: string } {
	const idx = name.lastIndexOf(".");
	return idx > 0
		? { stem: name.slice(0, idx), ext: name.slice(idx) }
		: { stem: name, ext: "" };
}

/** Directory a page's child pages belong in, given that page's own path.
 *
 * A vault path is a FILE path (`a/b.md`), so a note can never also be a
 * directory — its children go in a sibling folder with the same stem
 * (`a/b/`), the folder-note layout Obsidian supports natively. A folder
 * (or the vault root "") maps to itself.
 *
 * Shared by the applier (where new/moved children land) and the planner
 * (where an added item's full path is computed), so the two phases can
 * never disagree about a child's location. */
export function childDirOf(
	parentPath: string,
	parentKind: "folder" | "note" | "file",
): string {
	if (parentKind === "folder") return parentPath;
	const idx = parentPath.lastIndexOf("/");
	const dir = idx === -1 ? "" : parentPath.slice(0, idx);
	const stem = parentPath.slice(idx + 1).replace(/\.md$/i, "");
	return dir === "" ? stem : `${dir}/${stem}`;
}

/**
 * Pick a path under dir for `name` avoiding `used` (a Set of lowercase
 * paths already taken) — appends ` (2)`, ` (3)`, … before the extension.
 */
export function collisionFreePath(
	dir: string,
	name: string,
	used: Set<string>,
): string {
	const { stem, ext } = splitExt(name);
	for (let i = 1; ; i++) {
		const candidate = `${dir}${stem}${i === 1 ? "" : ` (${i})`}${ext}`;
		if (!used.has(candidate.toLowerCase())) {
			used.add(candidate.toLowerCase());
			return candidate;
		}
	}
}

/** `(conflict <deviceShort> <ISO>')` copy name for pull conflicts. */
export function conflictPath(
	path: string,
	deviceShort: string,
	when: Date,
): string {
	const stamp = when.toISOString().replace(/[:.]/g, "-");
	const { stem, ext } = splitExt(path);
	return `${stem} (conflict ${deviceShort} ${stamp})${ext}`;
}
