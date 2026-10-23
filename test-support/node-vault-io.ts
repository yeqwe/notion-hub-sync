import {
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
	statSync,
	renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import type { VaultFile, VaultIO } from "../src/sync/vault-io";
import { RenameTracker } from "../src/sync/rename-tracker";

/** fs-backed VaultIO rooted at a temp dir — used in live tests. */
export class NodeVaultIO implements VaultIO {
	constructor(private readonly root: string) {}

	private abs(path: string): string {
		return join(this.root, ...path.split("/"));
	}

	async list(): Promise<{ files: VaultFile[]; folders: string[] }> {
		const files: VaultFile[] = [];
		const folders: string[] = [];
		const walk = (rel: string) => {
			const dir = this.abs(rel);
			if (!existsSync(dir)) return;
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const p = rel === "" ? e.name : `${rel}/${e.name}`;
				if (e.isDirectory()) {
					folders.push(p);
					walk(p);
				} else {
					files.push({
						path: p,
						size: statSync(this.abs(p)).size,
						mtime: statSync(this.abs(p)).mtimeMs,
					});
				}
			}
		};
		walk("");
		return { files, folders };
	}

	async readText(path: string): Promise<string> {
		return readFileSync(this.abs(path), "utf8");
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const b = readFileSync(this.abs(path));
		return b.buffer.slice(
			b.byteOffset,
			b.byteOffset + b.byteLength,
		) as ArrayBuffer;
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.writes.expect(path, path);
		await this.mkdirp(dirname(path) === "." ? "" : dirname(path));
		writeFileSync(this.abs(path), Buffer.from(data));
	}

	async mkdirp(path: string): Promise<void> {
		if (path === "" || path === ".") return;
		mkdirSync(this.abs(path), { recursive: true });
	}

	async exists(path: string): Promise<boolean> {
		return existsSync(this.abs(path));
	}

	async stat(path: string): Promise<{ size: number; mtime: number } | null> {
		try {
			const s = statSync(this.abs(path));
			return s.isFile() ? { size: s.size, mtime: s.mtimeMs } : null;
		} catch {
			return null;
		}
	}

	readonly renames = new RenameTracker();
	readonly writes = new RenameTracker();

	async writeText(path: string, content: string): Promise<void> {
		this.writes.expect(path, path);
		await this.mkdirp(dirname(path) === "." ? "" : dirname(path));
		writeFileSync(this.abs(path), content);
	}

	async rename(from: string, to: string): Promise<void> {
		this.renames.expect(from, to);
		this.writes.expect(to, to);
		await this.mkdirp(dirname(to) === "." ? "" : dirname(to));
		renameSync(this.abs(from), this.abs(to));
	}

	async trash(path: string): Promise<void> {
		this.writes.expect(path, path);
		// Trashing a folder's files first creates `.trash/<dir>/`, so trashing
		// the now-empty `<dir>` must not collide with it — a real trash
		// (OS recycle bin / Obsidian's .trash) suffixes instead of failing.
		let dest = `.trash/${path}`;
		for (let i = 2; existsSync(this.abs(dest)); i++) {
			dest = `.trash/${path} (${i})`;
		}
		await this.mkdirp(dirname(dest));
		renameSync(this.abs(path), this.abs(dest));
	}
}
