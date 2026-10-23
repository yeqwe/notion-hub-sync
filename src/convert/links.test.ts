// 只测「哪些链接目标 Notion 会丢」这一个纯函数。
// 依据不是文档，是 scripts/probe-badurl2.mjs / probe-badurl3.mjs 实测：
//   markdown 端点（我们在用）静默剥掉 obsidian:// file:// 空目标 → 不报错，只丢链接
//   blocks 端点才会 400 Invalid URL for link → 我们不走那条路
import { describe, expect, it } from "vitest";
import { isDroppedLinkTarget } from "./links";

describe("isDroppedLinkTarget", () => {
	it("flags schemes Notion strips", () => {
		expect(isDroppedLinkTarget("obsidian://open?vault=V&file=a")).toBe(true);
		expect(isDroppedLinkTarget("file:///C:/a.md")).toBe(true);
		expect(isDroppedLinkTarget("")).toBe(true);
		expect(isDroppedLinkTarget("   ")).toBe(true);
		expect(isDroppedLinkTarget("javascript:alert(1)")).toBe(true);
	});

	it("keeps what Notion stores verbatim", () => {
		expect(isDroppedLinkTarget("https://example.com/a")).toBe(false);
		expect(isDroppedLinkTarget("http://example.com")).toBe(false);
		expect(isDroppedLinkTarget("mailto:a@b.c")).toBe(false);
		// relative + anchor survive untouched (measured), so they must not
		// produce a warning — a warning nobody can act on is noise.
		expect(isDroppedLinkTarget("notes/a.md")).toBe(false);
		expect(isDroppedLinkTarget("#section")).toBe(false);
		expect(isDroppedLinkTarget("./a.md")).toBe(false);
	});

	it("does not mistake a Windows path or a bare name for a scheme", () => {
		expect(isDroppedLinkTarget("C:/notes/a.md")).toBe(true); // single-letter scheme is still a scheme
		expect(isDroppedLinkTarget("a.md")).toBe(false);
	});
});
