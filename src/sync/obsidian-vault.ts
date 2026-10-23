import type { App, TAbstractFile, TFile, TFolder } from "obsidian";
import type { VaultFile, VaultIO } from "./vault-io";
import { WriteVerificationError } from "./vault-io";
import { emptyState, type SyncState } from "./state";
import { isSyncablePath, parentDir } from "./vault-io";
import { RenameTracker } from "./rename-tracker";
import { sha256Hex } from "./hashes";

const STATE_FILE = "sync-state.json";

export class ObsidianVaultIO implements VaultIO {
	constructor(private readonly app: App) {}

	async list(): Promise<{ files: VaultFile[]; folders: string[] }> {
		const files: VaultFile[] = [];
		const folders: string[] = [];
		for (const f of this.app.vault.getAllLoadedFiles()) {
			if (!isSyncablePath(f.path)) {
				continue;
			}
			if ((f as TFile).extension !== undefined) {
				const tf = f as TFile;
				files.push({
					path: tf.path,
					size: tf.stat.size,
					mtime: tf.stat.mtime,
				});
			} else {
				const dir = (f as TFolder).path;
				if (dir !== "" && dir !== "/") {
					folders.push(dir);
				}
			}
		}
		return { files, folders };
	}

	private file(path: string): TAbstractFile {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!f) {
			throw new Error(`vault file not found: ${path}`);
		}
		return f;
	}

	async readText(path: string): Promise<string> {
		return this.app.vault.read(this.file(path) as TFile);
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		return this.app.vault.readBinary(this.file(path) as TFile);
	}

	readonly writes = new RenameTracker();

	async writeText(path: string, content: string): Promise<void> {
		this.writes.expect(path, path);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing) {
			await this.app.vault.modify(existing as TFile, content);
		} else {
			await this.mkdirp(parentDir(path));
			await this.app.vault.create(path, content);
		}
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.writes.expect(path, path);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing) {
			await this.app.vault.modifyBinary(existing as TFile, data);
		} else {
			await this.mkdirp(parentDir(path));
			await this.app.vault.createBinary(path, data);
		}
	}

	/**
	 * Verified binary write: temp file → read back → compare → move into place.
	 *
	 * Reading back rather than trusting `writeBinary`'s promise is the whole
	 * point: the adapter resolves once the write is *queued* on some platforms,
	 * and a partially flushed file looks identical to a complete one until you
	 * hash it. Falling back to a direct write is NOT an option here — that is
	 * the behaviour this method exists to replace.
	 */
	async writeBinaryVerified(
		path: string,
		data: ArrayBuffer,
		expectedSha: string,
	): Promise<void> {
		await this.writeVerified(path, new Uint8Array(data), expectedSha);
	}

	/** Text twin of {@link writeBinaryVerified} — compared on the encoded
	 * bytes so the hash matches what the remote side recorded. */
	async writeTextVerified(
		path: string,
		content: string,
		expectedSha: string,
	): Promise<void> {
		await this.writeVerified(
			path,
			new TextEncoder().encode(content),
			expectedSha,
		);
	}

	private async writeVerified(
		path: string,
		bytes: Uint8Array,
		expectedSha: string,
	): Promise<void> {
		const tmp = `${path}.nhs-tmp`;
		this.writes.expect(tmp, tmp);
		await this.mkdirp(parentDir(path));
		const buf = bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer;
		try {
			const existingTmp = this.app.vault.getAbstractFileByPath(tmp);
			if (existingTmp) {
				await this.app.vault.modifyBinary(existingTmp as TFile, buf);
			} else {
				await this.app.vault.createBinary(tmp, buf);
			}
			const readBack = new Uint8Array(
				await this.app.vault.adapter.readBinary(tmp),
			);
			const actual = await sha256Hex(readBack);
			if (actual !== expectedSha) {
				throw new WriteVerificationError(path, expectedSha, actual);
			}
		} finally {
			await this.app.vault.adapter.remove(tmp).catch(() => undefined);
		}
		// Verified. Only now may the target change — a failure above leaves
		// the previous content exactly as it was.
		this.writes.expect(path, path);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing) {
			await this.app.vault.modifyBinary(existing as TFile, buf);
		} else {
			await this.app.vault.createBinary(path, buf);
		}
	}

	async mkdirp(path: string): Promise<void> {
		if (path === "" || (await this.exists(path))) {
			return;
		}
		await this.mkdirp(parentDir(path));
		// The folder we are about to create is OURS. Register it first, or the
		// `create` event reaches the auto-sync listener as a user change and
		// schedules another round off the back of this one 鈥?on a pull that
		// creates a directory, every round would queue the next.
		this.writes.expect(path, path);
		try {
			await this.app.vault.createFolder(path);
		} catch {
			// Already there (a race with the user, or with another action): no
			// event will fire, so drop the expectation instead of letting it
			// swallow a real user create of the same path later.
			this.writes.forget(path, path);
		}
	}

	async exists(path: string): Promise<boolean> {
		return this.app.vault.getAbstractFileByPath(path) !== null;
	}

	async stat(path: string): Promise<{ size: number; mtime: number } | null> {
		const f = this.app.vault.getAbstractFileByPath(path) as TFile | null;
		if (!f || f.extension === undefined) return null;
		return { size: f.stat.size, mtime: f.stat.mtime };
	}

	readonly renames = new RenameTracker();

	async rename(from: string, to: string): Promise<void> {
		this.renames.expect(from, to);
		this.writes.expect(to, to);
		const f = this.file(from);
		await this.mkdirp(parentDir(to));
		await this.app.fileManager.renameFile(f, to);
	}

	async trash(path: string): Promise<void> {
		this.writes.expect(path, path);
		await this.app.fileManager.trashFile(this.file(path));
	}
}

/** Load sync-state.json next to the plugin dir.
 *
 * A failure here used to fall through to `emptyState()` silently, and that
 * is how a device gets stuck in a loop: one interrupted save leaves the
 * file truncated, the next round sees "no state", re-downloads the whole
 * vault (tens of minutes on mobile), and the save at the end of that long
 * round gets interrupted again. The round must be able to TELL the
 * difference between "first run" and "my state is unreadable" — the caller
 * refuses to plan against a fresh state in the second case.
 */
export interface LoadedState {
	state: SyncState;
	/** present when a state file existed but could not be used. */
	problem?: {
		kind: "corrupt" | "root-mismatch";
		detail: string;
		/** raw bytes seen, for the message (not the whole file). */
		bytes: number;
	};
}

export async function loadStateChecked(
	app: App,
	manifestDir: string,
	rootPageId: string,
): Promise<LoadedState> {
	const path = `${manifestDir}/${STATE_FILE}`;
	let raw: string;
	try {
		raw = await app.vault.adapter.read(path);
	} catch {
		return { state: emptyState(rootPageId) }; // genuinely absent
	}
	try {
		const parsed = JSON.parse(raw) as SyncState;
		if (parsed.version === 1 && parsed.rootPageId === rootPageId) {
			return { state: parsed };
		}
		return {
			state: emptyState(rootPageId),
			problem: {
				kind: "root-mismatch",
				detail: `version=${String(parsed.version)} rootPageId=${String(
					parsed.rootPageId,
				)} (expected ${rootPageId})`,
				bytes: raw.length,
			},
		};
	} catch (err) {
		return {
			state: emptyState(rootPageId),
			problem: {
				kind: "corrupt",
				detail: err instanceof Error ? err.message : String(err),
				bytes: raw.length,
			},
		};
	}
}

export async function loadState(
	app: App,
	manifestDir: string,
	rootPageId: string,
): Promise<SyncState> {
	return (await loadStateChecked(app, manifestDir, rootPageId)).state;
}

/** Write via a temp file + rename so an interrupted save (app backgrounded,
 * iOS killing the process) can never leave a half-written state file: the
 * old one stays intact until the new one is complete. */
export async function saveState(
	app: App,
	manifestDir: string,
	state: SyncState,
): Promise<void> {
	const path = `${manifestDir}/${STATE_FILE}`;
	const tmp = `${path}.tmp`;
	const text = JSON.stringify(state, null, 1);
	const adapter = app.vault.adapter;
	await adapter.write(tmp, text);
	try {
		if (await adapter.exists(path)) await adapter.remove(path);
		await adapter.rename(tmp, path);
	} catch {
		// adapter rename unavailable: fall back to a plain write. Still
		// better than the tmp file being the only copy.
		await adapter.write(path, text);
		await adapter.remove(tmp).catch(() => undefined);
	}
}

/** Keep a copy of an unusable state file so it can be inspected, and stop
 * it from being read again. */
export async function quarantineState(
	app: App,
	manifestDir: string,
	stamp: string,
): Promise<string | null> {
	const path = `${manifestDir}/${STATE_FILE}`;
	try {
		await app.vault.adapter.rename(path, `${path}.${stamp}.bad`);
		return `${path}.${stamp}.bad`;
	} catch {
		return null;
	}
}

/** Resolve an Obsidian link target to a vault path via metadataCache. */
export function makePathResolver(app: App) {
	return (target: string, sourcePath: string): string | null => {
		const dest = app.metadataCache.getFirstLinkpathDest(
			target,
			sourcePath,
		);
		return dest?.path ?? null;
	};
}
