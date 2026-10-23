import type { App, TAbstractFile, TFile, TFolder } from "obsidian";
import type { VaultFile, VaultIO } from "./vault-io";
import { emptyState, type SyncState } from "./state";
import { isSyncablePath, parentDir } from "./vault-io";
import { RenameTracker } from "./rename-tracker";

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

	async mkdirp(path: string): Promise<void> {
		if (path === "" || (await this.exists(path))) {
			return;
		}
		await this.mkdirp(parentDir(path));
		await this.app.vault.createFolder(path).catch(() => undefined);
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

/** Load sync-state.json next to the plugin dir; null on mismatch/absent. */
export async function loadState(
	app: App,
	manifestDir: string,
	rootPageId: string,
): Promise<SyncState> {
	const path = `${manifestDir}/${STATE_FILE}`;
	try {
		const raw = await app.vault.adapter.read(path);
		const parsed = JSON.parse(raw) as SyncState;
		if (parsed.version === 1 && parsed.rootPageId === rootPageId) {
			return parsed;
		}
	} catch {
		// missing or corrupt → fresh state
	}
	return emptyState(rootPageId);
}

export async function saveState(
	app: App,
	manifestDir: string,
	state: SyncState,
): Promise<void> {
	await app.vault.adapter.write(
		`${manifestDir}/${STATE_FILE}`,
		JSON.stringify(state, null, 1),
	);
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
