import { describe, expect, it, vi } from "vitest";
import { SyncLog, type LogEntry } from "./sync-log";

describe("SyncLog", () => {
	it("trims oldest beyond cap", () => {
		const log = new SyncLog({ cap: 3 });
		for (let i = 0; i < 5; i++) log.info(`m${i}`);
		expect(log.entries().map((e) => e.msg)).toEqual(["m2", "m3", "m4"]);
	});

	it("notifies listeners on add/clear/load and supports unsubscribe", () => {
		const log = new SyncLog();
		const cb = vi.fn();
		const off = log.onChange(cb);
		log.info("a");
		log.clear();
		log.load([{ t: 1, level: "warn", msg: "w" }]);
		expect(cb).toHaveBeenCalledTimes(3);
		off();
		log.info("b");
		expect(cb).toHaveBeenCalledTimes(3);
	});

	it("load ignores malformed entries and trims to cap", () => {
		const log = new SyncLog({ cap: 2 });
		log.load([
			{ t: 1, level: "info", msg: "ok" },
			{ t: "x", level: "info", msg: "bad t" },
			{ t: 2, level: "nope", msg: "bad level" },
			{ t: 3, level: "error", msg: "e" },
			null,
			"str",
			{ t: 4, level: "success", msg: "s" },
		]);
		expect(log.entries().map((e) => e.msg)).toEqual(["e", "s"]);
		log.load("not an array");
		expect(log.entries()).toEqual([]);
	});

	it("flush calls persist with current entries; clear persists empty", async () => {
		const seen: LogEntry[][] = [];
		const log = new SyncLog({
			persist: async (entries) => {
				seen.push(entries);
			},
		});
		log.info("a");
		await log.flush();
		expect(seen).toEqual([[{ t: expect.any(Number), level: "info", msg: "a" }]]);
		log.clear();
		expect(seen[1]).toEqual([]);
	});

	it("flush swallows persist errors", async () => {
		const log = new SyncLog({
			persist: () => Promise.reject(new Error("disk full")),
		});
		log.info("a");
		await expect(log.flush()).resolves.toBeUndefined();
	});

	it("keeps a vault path for clickable rows and drops bare ids", () => {
		const log = new SyncLog();
		log.success("Uploaded a/b.md (1 KB)", "a/b.md");
		log.info("Download b.md", "b.md");
		// engine fallback path is the entry id — not clickable
		log.warn("blocked", "0123456789abcdef0123456789abcdef");
		expect(log.entries().map((e) => e.path)).toEqual([
			"a/b.md",
			"b.md",
			undefined,
		]);
	});

	it("load keeps valid paths and drops malformed ones", () => {
		const log = new SyncLog();
		log.load([
			{ t: 1, level: "info", msg: "a", path: "a.md" },
			{ t: 2, level: "info", msg: "b", path: 5 },
			{ t: 3, level: "info", msg: "c", path: "" },
		]);
		expect(log.entries().map((e) => e.path)).toEqual([
			"a.md",
			undefined,
			undefined,
		]);
	});
});
