// Base-text store: the last-synced content of each note, keyed by page id
// (hex32), kept under the plugin dir (or a test dir). Used as merge3 base
// and as the "pre-delete" history snapshot when local content is gone.
// Notes > 1 MiB have no stored base — conflicts degrade to conflict copies.

const MAX_BASE_BYTES = 1024 * 1024;

export interface TextIO {
	read(path: string): Promise<string>;
	write(path: string, content: string): Promise<void>;
	remove(path: string): Promise<void>;
}

export class BaseStore {
	constructor(
		private readonly io: TextIO,
		private readonly dir: string,
	) {}

	private file(id: string): string {
		return `${this.dir}/base/${id}.md`;
	}

	async get(id: string): Promise<string | null> {
		try {
			return await this.io.read(this.file(id));
		} catch {
			return null;
		}
	}

	async put(id: string, text: string): Promise<void> {
		if (new TextEncoder().encode(text).byteLength > MAX_BASE_BYTES) {
			await this.remove(id); // too large to keep a merge base
			return;
		}
		await this.io.write(this.file(id), text);
	}

	async putIfFits(id: string, bytes: Uint8Array): Promise<void> {
		if (bytes.byteLength > MAX_BASE_BYTES) {
			await this.remove(id);
			return;
		}
		await this.io.write(this.file(id), new TextDecoder().decode(bytes));
	}

	async remove(id: string): Promise<void> {
		try {
			await this.io.remove(this.file(id));
		} catch {
			// already gone
		}
	}
}
