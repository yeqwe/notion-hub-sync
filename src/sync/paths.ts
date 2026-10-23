// Path rules for the vault side of the sync.
//
// Everything here is about *not producing a path the filesystem will refuse*
// and *agreeing on what two paths mean*. Both matter more than they look:
//
//  • a rejected write retries forever (the page exists, the file never
//    appears), so one bad title is a permanently stuck note;
//  • a path that "differs" between rounds reads as delete + create, which
//    trashes the remote page. On macOS the disk hands back NFD while Notion
//    hands back NFC — same file, different bytes — so every comparison in
//    the engine has to happen on one normal form.

/** Bytes accepted inside a single path segment by ext4 / APFS / NTFS. */
const MAX_NAME_BYTES = 200;

/** Whole-path ceiling. Not a filesystem limit (that varies per OS) but a
 * point past which Obsidian itself starts misbehaving, and past which the
 * next conflict-copy suffix would overflow anyway. */
export const MAX_PATH_BYTES = 900;

/** Characters no target filesystem accepts, plus the ones that would make
 * the name ambiguous in Obsidian (`:` and `|` are used in its own tables). */
const BAD_CHARS = /[\\/:*?"<>|]/g;

/** C0 controls + DEL. A newline in a filename is legal on Linux, rejected
 * on Windows, and silently mangles every log line in between; a NUL is
 * rejected everywhere. None of them can be recovered from, so none of them
 * survive. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/** Windows reserves these device names, *with or without* an extension:
 * `con.md` is as unopenable as `con`. */
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Does `name` (with or without extension) collide with a Windows device? */
export function isReservedName(name: string): boolean {
	const stem = name.replace(/\.[^.]*$/, "");
	return RESERVED_NAME.test(stem);
}

const encoder = new TextEncoder();

/** UTF-8 byte length — the unit filesystems actually limit. */
export function utf8Len(s: string): number {
	return encoder.encode(s).byteLength;
}

/** Cut `s` to at most `max` UTF-8 bytes without splitting a code point.
 * Iterates by code point rather than by `slice` so a 4-byte emoji is never
 * halved into U+FFFD (which would then be a different name every round). */
function truncateBytes(s: string, max: number): string {
	if (utf8Len(s) <= max) return s;
	let out = "";
	let used = 0;
	for (const ch of s) {
		const n = utf8Len(ch);
		if (used + n > max) break;
		out += ch;
		used += n;
	}
	return out;
}

/**
 * Turn a Notion page title into a safe path segment.
 *
 * Every step below fixes a name that would otherwise be written once and
 * then fail — or worse, be written under one name and looked up under
 * another. Order matters: normalize first (so the reserved-name and length
 * tests see the same bytes the disk will), strip controls before trimming
 * (so `"a\n"` is a real name and not just whitespace).
 */
export function sanitizeTitle(title: string): string {
	let s = title
		.normalize("NFC")
		.replace(CONTROL_CHARS, "-")
		.replace(BAD_CHARS, "-")
		// Windows silently drops trailing dots and spaces, so `name.` would
		// be written as `name` and never found again; leading dots hide the
		// file on unix.
		.replace(/^[.\s]+/, "")
		.replace(/[.\s]+$/, "");
	if (s === "") return "Untitled";
	// NOTE: reserved device names are NOT rewritten here. This function also
	// derives the page title from an existing entry (`nameFor`), and changing
	// it there would make a page stop matching its own base record — the
	// engine would then see a rename every round. The Windows problem is
	// handled where a path is actually written (see `safeFileName`).
	return truncateBytes(s, MAX_NAME_BYTES);
}

/** Last line of defence before a path is written to disk: a segment that
 * Windows cannot create gets a trailing `_`. Applied only to the FILE part,
 * never to a derived page title, so base records keep matching. */
export function safeFileName(name: string): string {
	if (!isReservedName(name)) return name;
	const dot = name.lastIndexOf(".");
	return dot > 0
		? `${name.slice(0, dot)}_${name.slice(dot)}`
		: `${name}_`;
}

/** Normalize a vault path the way every comparison in the engine expects:
 * one separator, no leading slash, NFC.
 *
 * macOS reports filenames as NFD while Notion returns NFC. Comparing the
 * two forms yields "not found", which the local snapshot reads as *deleted*
 * — and then the remote page gets trashed. Normalizing on the way in makes
 * the two sides agree by construction. */
export function normalizeVaultPath(path: string): string {
	const p = path.replace(/\\/g, "/").replace(/^\/+/, "").normalize("NFC");
	return p === "/" ? "" : p;
}

/** Is `path` short enough to be written everywhere we care about? */
export function pathFitsVault(path: string): boolean {
	if (utf8Len(path) > MAX_PATH_BYTES) return false;
	const name = path.slice(path.lastIndexOf("/") + 1);
	return utf8Len(name) <= MAX_NAME_BYTES * 1.2;
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
 *
 * The suffix is fitted back under the byte cap: a name that is already at
 * the limit would otherwise grow past it and fail to write on exactly the
 * rounds where a collision happened.
 */
export function collisionFreePath(
	dir: string,
	name: string,
	used: Set<string>,
): string {
	const { stem, ext } = splitExt(name);
	for (let i = 1; ; i++) {
		const suffix = i === 1 ? "" : ` (${i})`;
		const room = MAX_NAME_BYTES - utf8Len(suffix) - utf8Len(ext);
		const candidate = `${dir}${truncateBytes(stem, Math.max(1, room))}${suffix}${ext}`;
		if (!used.has(candidate.toLowerCase())) {
			used.add(candidate.toLowerCase());
			return candidate;
		}
	}
}

/** `(conflict <deviceShort> <ISO>')` copy name for pull conflicts.
 *
 * The stem is shortened to make room for the marker: a copy whose own name
 * pushes it past the byte cap could not be written at all — and a conflict
 * that cannot be written is a conflict that silently loses content. */
export function conflictPath(
	path: string,
	deviceShort: string,
	when: Date,
): string {
	const stamp = when.toISOString().replace(/[:.]/g, "-");
	const { stem, ext } = splitExt(path);
	const marker = ` (conflict ${deviceShort} ${stamp})`;
	const room = MAX_NAME_BYTES - utf8Len(marker) - utf8Len(ext);
	return `${truncateBytes(stem, Math.max(1, room))}${marker}${ext}`;
}

/**
 * Matches ONLY the shape `conflictPath` writes: `(conflict <dev> <UTC ISO>)`
 * with the millisecond field intact. Deliberately strict for three reasons:
 *
 *  • it must NOT match a user's own `报告 (conflict 草稿).md` — a loose
 *    "contains (conflict …)" test hid such files from sync entirely;
 *  • it must not match Obsidian's own `(Conflicted copy 2024-01-01)`; those
 *    are a different feature with a different lifecycle;
 *  • the timestamp shape is what distinguishes a copy generated by us from
 *    a name a human typed, so it is the load-bearing part.
 *
 * The milliseconds are optional: copies written before the format was
 * pinned have none (`…T00-00-00Z`), and those files are still in users'
 * vaults — refusing to recognize them would upload them as settings.
 */
export const CONFLICT_COPY_RE =
	/ \(conflict [^()/]+ \d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z(?:\)| \d+\))(?:\.[^/.]+)?$/;

/** Is `path` one of our conflict copies? */
export function isConflictCopyPath(path: string): boolean {
	return CONFLICT_COPY_RE.test(path);
}
