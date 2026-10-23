// Path sanitising: every case here used to produce a name the filesystem
// would refuse — or worse, one that was written under one name and looked up
// under another, which the engine reads as delete + create.

import { describe, expect, it } from "vitest";
import {
	isReservedName,
	normalizeVaultPath,
	safeFileName,
	sanitizeTitle,
	utf8Len,
	MAX_PATH_BYTES,
	pathFitsVault,
} from "../sync/paths";

describe("sanitizeTitle", () => {
	it("replaces the characters no filesystem accepts", () => {
		expect(sanitizeTitle('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j");
	});

	it("strips control characters, including newline and NUL", () => {
		// a newline in a filename is legal on Linux, rejected on Windows, and
		// mangles every log line in between
		expect(sanitizeTitle("line1\nline2")).toBe("line1-line2");
		expect(sanitizeTitle("a\u0000b")).toBe("a-b");
		expect(sanitizeTitle("tab\there")).toBe("tab-here");
		expect(sanitizeTitle("bell\u0007")).toBe("bell-");
	});

	it("normalises to NFC so a macOS NFD name matches the Notion NFC one", () => {
		const nfd = "café".normalize("NFD");
		expect(sanitizeTitle(nfd)).toBe("café".normalize("NFC"));
		// and the two forms are then the same string
		expect(sanitizeTitle(nfd)).toBe(sanitizeTitle("café"));
	});

	it("trims leading and trailing dots and spaces", () => {
		// Windows drops a trailing dot silently → the file is written as
		// `name` and can never be found again
		expect(sanitizeTitle("name.")).toBe("name");
		expect(sanitizeTitle("  spaced  ")).toBe("spaced");
		expect(sanitizeTitle("...")).toBe("Untitled");
	});

	it("falls back to a real name for empty input", () => {
		expect(sanitizeTitle("")).toBe("Untitled");
		expect(sanitizeTitle("   ")).toBe("Untitled");
	});

	it("caps the name at a length every filesystem accepts", () => {
		const long = sanitizeTitle("标".repeat(500));
		// 200 bytes / 3 bytes per CJK char
		expect(utf8Len(long)).toBeLessThanOrEqual(200);
		expect(long.length).toBeGreaterThan(0);
	});

	it("never splits a multi-byte character", () => {
		// truncating by bytes must not leave a lone surrogate or U+FFFD
		const s = sanitizeTitle("😀".repeat(100));
		expect(s).not.toContain("\uFFFD");
		expect(s).toBe("😀".repeat(Math.floor(200 / 4)));
	});

	it("leaves a reserved device name alone — that is a FILE concern", () => {
		// sanitizeTitle also derives page titles from existing entries; a
		// rewrite there would break the base record and cause a rename loop.
		expect(sanitizeTitle("Con")).toBe("Con");
	});
});

describe("isReservedName / safeFileName", () => {
	it("knows the Windows device names, with or without extension", () => {
		for (const n of ["CON", "con", "Con.md", "nul.txt", "COM1", "lpt9"]) {
			expect(isReservedName(n), n).toBe(true);
		}
		for (const n of ["console", "COM10", "null", "auxiliary"]) {
			expect(isReservedName(n), n).toBe(false);
		}
	});

	it("renames a reserved file, keeping the extension", () => {
		expect(safeFileName("CON.md")).toBe("CON_.md");
		expect(safeFileName("nul")).toBe("nul_");
	});

	it("passes ordinary names through untouched", () => {
		expect(safeFileName("note.md")).toBe("note.md");
		expect(safeFileName("病理学.md")).toBe("病理学.md");
	});
});

describe("normalizeVaultPath", () => {
	it("unifies separators and drops the leading slash", () => {
		expect(normalizeVaultPath("/a\\b/c.md")).toBe("a/b/c.md");
	});

	it("makes the NFD and NFC forms of one name equal", () => {
		const nfd = "妇产/café.md".normalize("NFD");
		const nfc = "妇产/café.md".normalize("NFC");
		expect(normalizeVaultPath(nfd)).toBe(normalizeVaultPath(nfc));
	});

	it("is idempotent", () => {
		const once = normalizeVaultPath("/a/b.md");
		expect(normalizeVaultPath(once)).toBe(once);
	});
});

describe("pathFitsVault", () => {
	it("rejects a path past the ceiling", () => {
		expect(pathFitsVault("a".repeat(MAX_PATH_BYTES + 10))).toBe(false);
		expect(pathFitsVault("notes/a.md")).toBe(true);
	});
});
