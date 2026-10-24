// The state file is the whole reason a device either converges or loops:
// an unreadable one used to be indistinguishable from "first run".

import { describe, expect, it } from "vitest";
import {
	mkdtempSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadStateChecked,
	ObsidianVaultIO,
	quarantineState,
	saveState,
} from "./obsidian-vault";
import { emptyState } from "./state";
import { sha256Hex } from "./hashes";
import { MarkdownView, type App } from "obsidian";

const ROOT = "40162671-1556-8043-a96b-ff36b3f3d90a";
const STATE_FILE = "sync-state.json";

/** Minimal vault.adapter stand-in: read/write/exists/remove/rename on a dir. */
function fakeApp(dir: string): App {
	const abs = (p: string) => join(dir, ...p.split("/").filter(Boolean));
	const fs = {
		read: async (p: string) => readFileSync(abs(p), "utf8"),
		write: async (p: string, c: string) => {
			writeFileSync(abs(p), c);
		},
		exists: async (p: string) => existsSync(abs(p)),
		remove: async (p: string) => {
			require("node:fs").unlinkSync(abs(p));
		},
		rename: async (a: string, b: string) => {
			require("node:fs").renameSync(abs(a), abs(b));
		},
	};
	return { vault: { adapter: fs } } as unknown as App;
}

function fmt(dir: string) {
	return {
		writeRaw(text: string) {
			writeFileSync(join(dir, STATE_FILE), text);
		},
		exists(p: string) {
			return existsSync(join(dir, ...p.split("/")));
		},
	};
}

describe("loadStateChecked", () => {
	it("absent file is a genuine first run (no problem)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nhs-ls-"));
		const r = await loadStateChecked(fakeApp(dir), "", ROOT);
		expect(r.problem).toBeUndefined();
		expect(r.state.entries).toEqual({});
	});

	it("truncated JSON is reported as corrupt, with the byte count", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nhs-ls-"));
		const raw = '{"version":1,"rootPageId":"40162671-1556';
		fmt(dir).writeRaw(raw);
		const r = await loadStateChecked(fakeApp(dir), "", ROOT);
		expect(r.problem?.kind).toBe("corrupt");
		expect(r.problem?.bytes).toBe(raw.length);
		expect(r.state.entries).toEqual({});
	});

	it("a state from a different root page is reported, not silently dropped", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nhs-ls-"));
		const other = emptyState("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
		fmt(dir).writeRaw(JSON.stringify(other));
		const r = await loadStateChecked(fakeApp(dir), "", ROOT);
		expect(r.problem?.kind).toBe("root-mismatch");
		expect(r.problem?.detail).toContain("expected");
	});

	it("a good state loads untouched", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nhs-ls-"));
		const st = emptyState(ROOT);
		st.entries = {
			abc: {
				path: "A.md",
				kind: "note",
				notionTitle: "A",
				parentId: ROOT,
			},
		};
		fmt(dir).writeRaw(JSON.stringify(st));
		const r = await loadStateChecked(fakeApp(dir), "", ROOT);
		expect(r.problem).toBeUndefined();
		expect(Object.keys(r.state.entries)).toEqual(["abc"]);
	});
});

describe("saveState", () => {
	it("leaves no temp file behind and its output loads back", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nhs-ss-"));
		const app = fakeApp(dir);
		const st = emptyState(ROOT);
		st.lastSyncAt = 123;
		await saveState(app, "", st);
		expect(fmt(dir).exists(`${STATE_FILE}.tmp`)).toBe(false);
		const back = await loadStateChecked(app, "", ROOT);
		expect(back.problem).toBeUndefined();
		expect(back.state.lastSyncAt).toBe(123);
	});
});

describe("quarantineState", () => {
	it("moves the damaged file aside so the next load is a clean first run", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nhs-qs-"));
		const app = fakeApp(dir);
		require("node:fs").mkdirSync(join(dir, "plugins", "nhs"), {
			recursive: true,
		});
		writeFileSync(join(dir, "plugins", "nhs", STATE_FILE), "{broken");
		const moved = await quarantineState(app, "plugins/nhs", "999");
		expect(moved).toBe(`plugins/nhs/${STATE_FILE}.999.bad`);
		expect(fmt(dir).exists(moved!)).toBe(true);
		expect(fmt(dir).exists(`plugins/nhs/${STATE_FILE}`)).toBe(false);
		const r = await loadStateChecked(app, "", ROOT);
		expect(r.problem).toBeUndefined();
	});
});

describe("ObsidianVaultIO.exists", () => {
	// local.ts asks this to distinguish "user deleted the file" from "the
	// vault index just has not seen it yet". Checking only the index makes
	// the second case look like a deletion and trashes the Notion page.
	function indexApp(dir: string, indexed: Set<string>): App {
		const abs = (p: string) => join(dir, ...p.split("/").filter(Boolean));
		return {
			vault: {
				getAbstractFileByPath: (p: string) =>
					indexed.has(p) ? { path: p } : null,
				adapter: {
					exists: async (p: string) => existsSync(abs(p)),
				},
			},
		} as unknown as App;
	}

	it("is true when the index missed a file that is on disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nhs-ex-"));
		writeFileSync(join(dir, "note.md"), "hi");
		const io = new ObsidianVaultIO(indexApp(dir, new Set()));
		expect(await io.exists("note.md")).toBe(true);
	});

	it("is true from the index alone, false when neither has it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nhs-ex-"));
		const io = new ObsidianVaultIO(indexApp(dir, new Set(["a.md"])));
		expect(await io.exists("a.md")).toBe(true);
		expect(await io.exists("b.md")).toBe(false);
	});
});

describe("ObsidianVaultIO.writeTextVerified tmp lifecycle", () => {
	// The tmp file fires TWO vault events: CREATE then DELETE. Each needs
	// its own `writes` expectation — when only the CREATE was covered, the
	// DELETE looked like a user change and scheduled a spurious round.
	it("covers both the tmp create and the tmp delete events", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nhs-wv-"));
		const abs = (p: string) => join(dir, ...p.split("/").filter(Boolean));
		const seen: { create?: boolean; del?: boolean } = {};
		let io!: ObsidianVaultIO;
		const app = {
			vault: {
				getAbstractFileByPath: (p: string) =>
					existsSync(abs(p))
						? {
								path: p,
								extension: "md",
								stat: { size: 1, mtime: 1 },
							}
						: null,
				createBinary: async (p: string, data: ArrayBuffer) => {
					writeFileSync(abs(p), new Uint8Array(data));
					if (p.endsWith(".nhs-tmp"))
						seen.create = io.writes.consume(p, p);
				},
				modifyBinary: async (
					f: { path: string },
					data: ArrayBuffer,
				) => {
					writeFileSync(abs(f.path), new Uint8Array(data));
				},
				adapter: {
					exists: async (p: string) => existsSync(abs(p)),
					readBinary: async (p: string) => {
						const b = readFileSync(abs(p));
						return b.buffer.slice(
							b.byteOffset,
							b.byteOffset + b.byteLength,
						);
					},
					remove: async (p: string) => {
						if (p.endsWith(".nhs-tmp"))
							seen.del = io.writes.consume(p, p);
						unlinkSync(abs(p));
					},
				},
			},
		} as unknown as App;
		io = new ObsidianVaultIO(app);

		const body = new TextEncoder().encode("verified body");
		const sha = await sha256Hex(body);
		await io.writeTextVerified("a.md", "verified body", sha);

		expect(seen.create).toBe(true);
		expect(seen.del).toBe(true);
		expect(fmt(dir).exists("a.md.nhs-tmp")).toBe(false);
		expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("verified body");
	});
});

describe("ObsidianVaultIO open-editor handling", () => {
	// Obsidian does not reload an open editor when a plugin writes under
	// it: the stale document is saved back over the pull later and reads
	// as a user edit. The IO must both detect the divergence and push the
	// new text into the open editor itself.
	class FakeView extends MarkdownView {
		constructor(path: string, text: string) {
			super(undefined as never);
			this.file = { path } as never;
			let doc = text;
			this.editor = {
				getValue: () => doc,
				setValue: (t: string) => {
					doc = t;
				},
				getCursor: () => ({ line: 0, ch: 0 }),
				setCursor: () => {},
				lineCount: () => doc.split("\n").length,
				getLine: (n: number) => doc.split("\n")[n] ?? "",
			} as never;
		}
	}

	function editorApp(dir: string) {
		const abs = (p: string) => join(dir, ...p.split("/").filter(Boolean));
		const views: FakeView[] = [];
		const app = {
			vault: {
				getAbstractFileByPath: (p: string) =>
					existsSync(abs(p))
						? { path: p, extension: "md", stat: { size: 1, mtime: 1 } }
						: null,
				read: async (f: { path: string }) =>
					readFileSync(abs(f.path), "utf8"),
				createBinary: async (p: string, data: ArrayBuffer) => {
					writeFileSync(abs(p), new Uint8Array(data));
				},
				modifyBinary: async (
					f: { path: string },
					data: ArrayBuffer,
				) => {
					writeFileSync(abs(f.path), new Uint8Array(data));
				},
				adapter: {
					exists: async (p: string) => existsSync(abs(p)),
					readBinary: async (p: string) => {
						const b = readFileSync(abs(p));
						return b.buffer.slice(
							b.byteOffset,
							b.byteOffset + b.byteLength,
						);
					},
					remove: async (p: string) => unlinkSync(abs(p)),
				},
			},
			workspace: {
				getLeavesOfType: () => views.map((view) => ({ view })),
			},
		} as unknown as App;
		return { app, views };
	}

	it("a verified write refreshes an open editor to the new text", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nhs-ed-"));
		writeFileSync(join(dir, "n.md"), "v1\n");
		const { app, views } = editorApp(dir);
		views.push(new FakeView("n.md", "v1\n")); // open, matches disk
		const io = new ObsidianVaultIO(app);
		const body = "v2\n";
		await io.writeTextVerified("n.md", body, await sha256Hex(
			new TextEncoder().encode(body),
		));
		expect(readFileSync(join(dir, "n.md"), "utf8")).toBe("v2\n");
		expect(views[0]!.editor.getValue()).toBe("v2\n");
	});

	it("editorDirty is true only when the open editor diverges from disk", async () => {
		const dir = mkdtempSync(join(tmpdir(), "nhs-ed-"));
		writeFileSync(join(dir, "n.md"), "v1\n");
		const { app, views } = editorApp(dir);
		const io = new ObsidianVaultIO(app);
		expect(await io.editorDirty("n.md")).toBe(false); // not open
		const v = new FakeView("n.md", "v1\n");
		views.push(v);
		expect(await io.editorDirty("n.md")).toBe(false); // open, clean
		v.editor.setValue("unsaved typing\n");
		expect(await io.editorDirty("n.md")).toBe(true);
	});
});
