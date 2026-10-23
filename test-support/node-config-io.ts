// fs-backed ConfigIO rooted at <dir>/.obsidian — used in tests.

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
	statSync,
	renameSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ConfigIO } from "../src/config/config-io";

export class NodeConfigIO implements ConfigIO {
	private readonly root: string;

	constructor(deviceDir: string) {
		this.root = join(deviceDir, ".obsidian");
	}

	private abs(rel: string): string {
		return rel === "" ? this.root : join(this.root, ...rel.split("/"));
	}

	async list(dir: string) {
		const files: string[] = [];
		const folders: string[] = [];
		const abs = this.abs(dir);
		if (!existsSync(abs)) return { files, folders };
		for (const e of readdirSync(abs, { withFileTypes: true })) {
			if (e.isDirectory()) folders.push(e.name);
			else files.push(e.name);
		}
		return { files, folders };
	}

	async stat(path: string) {
		try {
			const s = statSync(this.abs(path));
			return s.isFile() ? { size: s.size, mtime: s.mtimeMs } : null;
		} catch {
			return null;
		}
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const b = readFileSync(this.abs(path));
		return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const abs = this.abs(path);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, Buffer.from(data));
	}

	async trash(path: string): Promise<void> {
		const dest = join(this.root, ".trash", ...path.split("/"));
		mkdirSync(dirname(dest), { recursive: true });
		renameSync(this.abs(path), dest);
	}
}
