// Which paths this device syncs at all. Pure path predicates, no I/O —
// the scanner (local), the evaluator (remote) and the planner all ask the
// same instance so one round can never see two different answers.
//
// Two rules, deliberately kept apart:
//  • file types   — a note always syncs (md/canvas/base); other extensions
//                   are grouped into images / audio / video / pdf / other
//                   and switched on per group;
//  • excluded folders — a path prefix that never syncs, whatever it holds.
//
// A path outside the scope must produce NO action at all. That matters far
// more than the saving in requests: "not in scope" is not "deleted", and
// letting such a path through to the planner would read a local absence as
// a remote deletion and trash the other side. `runSync` therefore drops
// out-of-scope ids from every planner input, so they never reach a rule.

/** Note formats Obsidian opens natively — always synced, no switch. */
const NOTE_EXTS = ["md", "canvas", "base"];
const IMAGE_EXTS = [
	"bmp", "png", "jpg", "jpeg", "gif", "svg", "webp", "avif",
];
const AUDIO_EXTS = [
	"mp3", "wav", "m4a", "3gp", "flac", "ogg", "oga", "opus",
];
const VIDEO_EXTS = ["mp4", "webm", "ogv", "mov", "mkv"];
const PDF_EXTS = ["pdf"];

export type FileKind = "note" | "image" | "audio" | "video" | "pdf" | "other";

export interface ScopeSettings {
	images: boolean;
	audio: boolean;
	video: boolean;
	pdf: boolean;
	/** Everything Obsidian cannot open (zip, exe, psd, …). */
	other: boolean;
	/** Vault-relative directory prefixes that never sync. */
	excludedFolders: string[];
}

/** Defaults mirror Obsidian's own sync: images / audio / video / pdf on,
 * "other" off (it is the group that surprises people with gigabytes). */
export function defaultScope(): ScopeSettings {
	return {
		images: true,
		audio: true,
		video: true,
		pdf: true,
		other: false,
		excludedFolders: [],
	};
}

const extLower = (path: string): string => {
	const name = path.split("/").pop() ?? path;
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};

export function classifyPath(path: string): FileKind {
	const ext = extLower(path);
	if (NOTE_EXTS.includes(ext)) return "note";
	if (IMAGE_EXTS.includes(ext)) return "image";
	if (AUDIO_EXTS.includes(ext)) return "audio";
	if (VIDEO_EXTS.includes(ext)) return "video";
	if (PDF_EXTS.includes(ext)) return "pdf";
	return "other";
}

/** Trim, drop leading/trailing slashes and empty entries, de-duplicate.
 * `private/` and `private` must behave identically — the match is a
 * prefix test, so a stored trailing slash would never hit `private/x`. */
export function normalizeExcludedFolders(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		const clean = item
			.replace(/\\/g, "/")
			// trim FIRST: "  Private/  " must lose the padding before the
			// trailing slash can be recognized
			.trim()
			.replace(/^\/+/, "")
			.replace(/\/+$/, "");
		if (clean === "" || seen.has(clean)) continue;
		seen.add(clean);
		out.push(clean);
	}
	return out;
}

/** Fill missing/odd keys from the defaults. Settings can arrive from an
 * older data.json or a hand-edited one; a missing key must not silently
 * widen (or empty) the sync scope. */
export function normalizeScope(raw: unknown): ScopeSettings {
	const d = defaultScope();
	const src = (raw ?? {}) as Partial<ScopeSettings>;
	const bool = (v: unknown, fallback: boolean): boolean =>
		typeof v === "boolean" ? v : fallback;
	return {
		images: bool(src.images, d.images),
		audio: bool(src.audio, d.audio),
		video: bool(src.video, d.video),
		pdf: bool(src.pdf, d.pdf),
		other: bool(src.other, d.other),
		excludedFolders: normalizeExcludedFolders(src.excludedFolders),
	};
}

/** Does `path` sit inside (or equal) one of the excluded folders? */
export function inExcludedFolder(
	path: string,
	excludedFolders: readonly string[],
): boolean {
	for (const dir of excludedFolders) {
		if (path === dir || path.startsWith(`${dir}/`)) return true;
	}
	return false;
}

/** Whether a file of `path`'s type is synced (ignores excluded folders). */
export function typeAllowed(path: string, s: ScopeSettings): boolean {
	// webm is listed as both audio and video; either switch admits it
	const ext = extLower(path);
	if (ext === "webm") return s.audio || s.video;
	switch (classifyPath(path)) {
		case "note":
			return true;
		case "image":
			return s.images;
		case "audio":
			return s.audio;
		case "video":
			return s.video;
		case "pdf":
			return s.pdf;
		default:
			return s.other;
	}
}

/** Full scope test for one vault path.
 *
 * `isDir` matters: a directory is structure, not a file type, and it has
 * no extension — routing it through `typeAllowed` would classify it as
 * "other" and drop every folder the moment that group is off. */
export function scopeAllows(
	path: string,
	isDir: boolean,
	s: ScopeSettings,
): boolean {
	if (path === "") return true; // vault root
	if (inExcludedFolder(path, s.excludedFolders)) return false;
	if (isDir) return true;
	return typeAllowed(path, s);
}

/** Bound predicate for the scanners and the planner. */
export function makeScope(s: ScopeSettings) {
	const scope = normalizeScope(s);
	return {
		settings: scope,
		allows: (path: string, isDir: boolean): boolean =>
			scopeAllows(path, isDir, scope),
		isEmpty: (): boolean =>
			scope.images &&
			scope.audio &&
			scope.video &&
			scope.pdf &&
			scope.other &&
			scope.excludedFolders.length === 0,
	};
}

export type Scope = ReturnType<typeof makeScope>;
