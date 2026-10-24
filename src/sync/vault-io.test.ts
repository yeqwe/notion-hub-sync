import { describe, expect, it } from "vitest";
import { isSyncablePath } from "./vault-io";

describe("isSyncablePath", () => {
	it("accepts ordinary vault paths", () => {
		expect(isSyncablePath("a.md")).toBe(true);
		expect(isSyncablePath("dir/sub/b.png")).toBe(true);
	});

	it("rejects dot-segments (`.obsidian`, hidden files)", () => {
		expect(isSyncablePath(".obsidian/app.json")).toBe(false);
		expect(isSyncablePath("a/.hidden")).toBe(false);
	});

	it("rejects `.nhs-tmp` staging leftovers at any depth", () => {
		// iOS can kill the app mid-verified-write; the leftover must not be
		// pushed as a 📎 file on the next round.
		expect(isSyncablePath("a.md.nhs-tmp")).toBe(false);
		expect(isSyncablePath("dir/b.md.nhs-tmp")).toBe(false);
	});
});
