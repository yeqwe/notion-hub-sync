// ConfigIO: filesystem access scoped to vault.configDir (paths are
// relative to it, forward-slash). Obsidian impl wraps vault.adapter;
// Node impl lives in test-support.

import type { App } from "obsidian";

export interface ConfigIO {
	/** names directly inside dir (dir "" = configDir root) */
	list(dir: string): Promise<{ files: string[]; folders: string[] }>;
	stat(path: string): Promise<{ size: number; mtime: number } | null>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	/** trashLocal if the platform supports it, else permanent remove. */
	trash(path: string): Promise<void>;
}

interface AdapterLike {
	list(path: string): Promise<{ files: string[]; folders: string[] }>;
	stat(path: string): Promise<{ size: number; mtime: number } | null>;
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	mkdir(path: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	remove(path: string): Promise<void>;
	trashLocal?: (path: string) => Promise<void>;
}

export class ObsidianConfigIO implements ConfigIO {
	private readonly adapter: AdapterLike;

	constructor(
		app: App,
		private readonly configDir: string,
	) {
		this.adapter = app.vault.adapter as unknown as AdapterLike;
	}

	private abs(rel: string): string {
		return rel === "" ? this.configDir : `${this.configDir}/${rel}`;
	}

	async list(dir: string): Promise<{ files: string[]; folders: string[] }> {
		try {
			const l = await this.adapter.list(this.abs(dir));
			const base = this.abs(dir);
			const strip = (p: string) =>
				p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p;
			return {
				files: l.files.map(strip).filter((p) => !p.includes("/")),
				folders: l.folders.map(strip).filter((p) => !p.includes("/")),
			};
		} catch {
			return { files: [], folders: [] };
		}
	}

	stat(path: string) {
		return this.adapter.stat(this.abs(path));
	}

	readBinary(path: string) {
		return this.adapter.readBinary(this.abs(path));
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const dir = path.split("/").slice(0, -1).join("/");
		if (dir) {
			await this.adapter.mkdir(this.abs(dir)).catch(() => undefined);
		}
		await this.adapter.writeBinary(this.abs(path), data);
	}

	async trash(path: string): Promise<void> {
		if (typeof this.adapter.trashLocal === "function") {
			await this.adapter.trashLocal(this.abs(path));
		} else {
			await this.adapter.remove(this.abs(path));
		}
	}
}
