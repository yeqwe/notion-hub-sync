import { sha256Hex } from "./hashes";

export interface VaultFile {
	path: string;
	size: number;
	mtime?: number;
}

export interface VaultIO {
	list(): Promise<{ files: VaultFile[]; folders: string[] }>;
	readText(path: string): Promise<string>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeText(path: string, content: string): Promise<void>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	/** Write bytes and prove they landed intact.
	 *
	 * A pull that is interrupted mid-write (iOS backgrounding the app, a
	 * dropped Wi-Fi association, a quota error that surfaces late) leaves a
	 * TRUNCATED file — and the base already recorded the remote hash, so the
	 * next round sees "local == base" and never repairs it. Markdown is the
	 * worst case: a cut-off note still opens, so nobody notices.
	 *
	 * Optional: when absent, {@link writeVerified} falls back to "write,
	 * read back, compare", which still catches the truncation (just after
	 * the original content is gone). Implementations that can should stage
	 * to a temp path and move it into place only after the hash matches. */
	writeBinaryVerified?(
		path: string,
		data: ArrayBuffer,
		expectedSha: string,
	): Promise<void>;
	/** Same guarantee for text, compared on the UTF-8 bytes of the string. */
	writeTextVerified?(
		path: string,
		content: string,
		expectedSha: string,
	): Promise<void>;
	mkdirp(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	/** size + mtime of a file, or null if missing. */
	stat(path: string): Promise<{ size: number; mtime: number } | null>;
	/** Rename/move a file or folder (link-updating on Obsidian).
	 * Implementations must register the pair in `renames` first so the
	 * vault rename-event listener can tell engine moves from user moves. */
	rename(from: string, to: string): Promise<void>;
	/** Expected-renames registry shared with the rename listener. */
	readonly renames: import("./rename-tracker").RenameTracker;
	/** Expected writes/creates/deletes (path→path) so engine file ops
	 * don't re-trigger auto-sync. */
	readonly writes: import("./rename-tracker").RenameTracker;
	/** Move a path to the trash (Obsidian trash / .trash/ dir in tests). */
	trash(path: string): Promise<void>;
}

/** Hidden/config paths are never synced. */
export function isSyncablePath(path: string): boolean {
	// A `.nhs-tmp` leftover (the OS killed the app between the verified
	// write's staging and cleanup) is ours, not user content — it must
	// never be listed, pushed as a 📎 file, or treated as a user event.
	if (path.endsWith(".nhs-tmp")) return false;
	return !path.split("/").some((seg) => seg.startsWith("."));
}

/** Raised when a write reached the disk in a different shape than intended. */
export class WriteVerificationError extends Error {
	constructor(
		readonly path: string,
		readonly expected: string,
		readonly actual: string,
	) {
		super(
			`${path}: wrote ${actual.slice(0, 8)}… but expected ${expected.slice(0, 8)}… (write truncated or post-processed) — the file was left in place for the next round`,
		);
		this.name = "WriteVerificationError";
	}
}

/**
 * Write `bytes` to `path` and prove the result hashes to `expectedSha`.
 *
 * Uses the IO's staged writer when it has one. Otherwise it degrades to
 * "write, read back, hash" — which still DETECTS truncation, just after the
 * old content is already gone. Detection is what matters: without it the
 * base records the remote hash, the next round sees "local == base" and the
 * half-written file is never repaired. A cut-off Markdown note is the worst
 * case because it still opens.
 */
export async function writeVerified(
	io: VaultIO,
	path: string,
	bytes: Uint8Array,
	expectedSha: string,
): Promise<void> {
	const buf = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
	if (io.writeBinaryVerified) {
		await io.writeBinaryVerified(path, buf, expectedSha);
		return;
	}
	await io.writeBinary(path, buf);
	const back = new Uint8Array(await io.readBinary(path));
	const actual = await sha256Hex(back);
	if (actual !== expectedSha) {
		throw new WriteVerificationError(path, expectedSha, actual);
	}
}

/** Text twin of {@link writeVerified}. */
export async function writeTextVerified(
	io: VaultIO,
	path: string,
	content: string,
	expectedSha: string,
): Promise<void> {
	if (io.writeTextVerified) {
		await io.writeTextVerified(path, content, expectedSha);
		return;
	}
	await writeVerified(
		io,
		path,
		new TextEncoder().encode(content),
		expectedSha,
	);
}

export function parentDir(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

export function basename(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.slice(idx + 1);
}
