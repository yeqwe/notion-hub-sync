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
	return !path.split("/").some((seg) => seg.startsWith("."));
}

export function parentDir(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

export function basename(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.slice(idx + 1);
}
