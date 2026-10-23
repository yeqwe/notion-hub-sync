// Sync scope: pure path predicates. These decide what a device syncs at
// all, so they carry the invariants that keep a scoped-out path from ever
// reaching a destructive rule.

import { describe, expect, it } from "vitest";
import {
	defaultScope,
	makeScope,
	normalizeExcludedFolders,
	normalizeScope,
	scopeAllows,
	typeAllowed,
	classifyPath,
} from "../sync/scope";

describe("classifyPath", () => {
	it("groups extensions the way the settings do", () => {
		expect(classifyPath("a/b/note.md")).toBe("note");
		expect(classifyPath("note.canvas")).toBe("note");
		expect(classifyPath("v.base")).toBe("note");
		expect(classifyPath("img.PNG")).toBe("image");
		expect(classifyPath("x/y.flac")).toBe("audio");
		expect(classifyPath("clip.mp4")).toBe("video");
		expect(classifyPath("doc.pdf")).toBe("pdf");
		expect(classifyPath("archive.zip")).toBe("other");
		expect(classifyPath("no-extension")).toBe("other");
	});
});

describe("typeAllowed", () => {
	const s = defaultScope();

	it("notes always sync, whatever the switches say", () => {
		const off = {
			images: false,
			audio: false,
			video: false,
			pdf: false,
			other: false,
			excludedFolders: [],
		};
		expect(typeAllowed("a.md", off)).toBe(true);
		expect(typeAllowed("b.canvas", off)).toBe(true);
	});

	it("defaults allow media but not 'other'", () => {
		expect(typeAllowed("a.png", s)).toBe(true);
		expect(typeAllowed("a.pdf", s)).toBe(true);
		expect(typeAllowed("a.zip", s)).toBe(false);
	});

	it("webm is admitted by either audio or video", () => {
		expect(typeAllowed("a.webm", { ...s, audio: true, video: false })).toBe(
			true,
		);
		expect(typeAllowed("a.webm", { ...s, audio: false, video: true })).toBe(
			true,
		);
		expect(typeAllowed("a.webm", { ...s, audio: false, video: false })).toBe(
			false,
		);
	});
});

describe("scopeAllows", () => {
	const s = { ...defaultScope(), excludedFolders: ["Private", "raw/assets"] };

	it("a directory is structure, never a file type", () => {
		// without the isDir branch every folder would be classified as "other"
		// and vanish the moment that group is switched off
		expect(scopeAllows("Some Folder", true, { ...s, other: false })).toBe(
			true,
		);
	});

	it("excluded folders match by path prefix, not substring", () => {
		expect(scopeAllows("Private/a.md", false, s)).toBe(false);
		expect(scopeAllows("Private", true, s)).toBe(false);
		expect(scopeAllows("Private/sub/deep.png", false, s)).toBe(false);
		expect(scopeAllows("raw/assets/x.png", false, s)).toBe(false);
		// a sibling whose name merely starts with the same letters stays in
		expect(scopeAllows("Privateer/a.md", false, s)).toBe(true);
		expect(scopeAllows("raw/assets2/x.png", false, s)).toBe(true);
	});

	it("the vault root is always allowed", () => {
		expect(scopeAllows("", true, s)).toBe(true);
	});
});

describe("normalizeExcludedFolders", () => {
	it("trims separators, drops blanks, de-duplicates", () => {
		expect(
			normalizeExcludedFolders([
				"  Private/  ",
				"/raw\\assets",
				"",
				"   ",
				"Private",
				null,
				42,
			]),
		).toEqual(["Private", "raw/assets"]);
	});

	it("a trailing slash cannot survive — the match is a prefix test", () => {
		expect(normalizeExcludedFolders(["Private/"])).toEqual(["Private"]);
		// and it therefore still matches a path inside it
		const s = { ...defaultScope(), excludedFolders: ["Private"] };
		expect(scopeAllows("Private/a.md", false, s)).toBe(false);
	});
});

describe("normalizeScope", () => {
	it("fills missing keys from the defaults instead of widening scope", () => {
		const s = normalizeScope({ images: false });
		expect(s.images).toBe(false);
		expect(s.audio).toBe(true);
		expect(s.other).toBe(false);
		expect(s.excludedFolders).toEqual([]);
	});

	it("survives a completely garbage value", () => {
		expect(normalizeScope(null)).toEqual(defaultScope());
		expect(normalizeScope("nope")).toEqual(defaultScope());
		expect(normalizeScope({ images: "yes" }).images).toBe(true);
	});
});

describe("makeScope", () => {
	it("normalizes once and reports whether it restricts anything", () => {
		const wide = makeScope(defaultScope());
		// "other" is off by default, so even the default restricts something
		expect(wide.isEmpty()).toBe(false);

		const everything = makeScope({
			images: true,
			audio: true,
			video: true,
			pdf: true,
			other: true,
			excludedFolders: [],
		});
		expect(everything.isEmpty()).toBe(true);
		expect(everything.allows("a.zip", false)).toBe(true);
	});
});
