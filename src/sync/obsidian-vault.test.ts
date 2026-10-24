// The state file is the whole reason a device either converges or loops:
// an unreadable one used to be indistinguishable from "first run".

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadStateChecked,
	ObsidianVaultIO,
	quarantineState,
	saveState,
} from "./obsidian-vault";
import { emptyState } from "./state";
import type { App } from "obsidian";

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
