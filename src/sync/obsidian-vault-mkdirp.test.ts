// Engine-created folders must not look like user edits.
//
// `ObsidianVaultIO.mkdirp` creates directories on the way to a write. The
// auto-sync listener treats an unregistered `create` event as a user change
// and schedules another round 鈥?so a pull that creates a directory used to
// queue the next round off its own work.

import { describe, expect, it, vi } from "vitest";
import type { App } from "obsidian";
import { ObsidianVaultIO } from "./obsidian-vault";

/** Adapter+vault stand-in: folder set in memory, no real files. */
function fakeApp(initial: string[] = []) {
	const folders = new Set(initial);
	const created: string[] = [];
	/** when set, createFolder rejects (the folder appeared underneath us). */
	let rejectNext = false;
	const app = {
		vault: {
			getAbstractFileByPath: (p: string) =>
				folders.has(p) ? { path: p, extension: undefined } : null,
			createFolder: vi.fn(async (p: string) => {
				if (rejectNext) {
					rejectNext = false;
					throw new Error("Folder already exists");
				}
				folders.add(p);
				created.push(p);
			}),
		},
	};
	return {
		app: app as unknown as App,
		folders,
		created,
		rejectNext: () => {
			rejectNext = true;
		},
	};
}

describe("ObsidianVaultIO.mkdirp", () => {
	it("registers the folder it creates as an engine write", async () => {
		const f = fakeApp();
		const io = new ObsidianVaultIO(f.app);
		await io.mkdirp("a/b");
		expect(f.created).toEqual(["a", "a/b"]);
		// both are consumed by the listener and neither leaks to the next round
		expect(io.writes.consume("a", "a")).toBe(true);
		expect(io.writes.consume("a/b", "a/b")).toBe(true);
	});

	it("does not register anything when the folder already exists", async () => {
		const f = fakeApp(["a"]);
		const io = new ObsidianVaultIO(f.app);
		await io.mkdirp("a");
		expect(io.writes.consume("a", "a")).toBe(false);
	});

	it("withdraws the registration when createFolder fails", async () => {
		// No event fires for a failed create, so a leftover expectation would
		// later swallow a REAL user create of the same path.
		const f = fakeApp();
		const io = new ObsidianVaultIO(f.app);
		f.rejectNext();
		await io.mkdirp("x");
		expect(io.writes.consume("x", "x")).toBe(false);
	});
});
