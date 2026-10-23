// Blocked paths + their wording. The point of these tests is that a file
// which did not sync can never look like a file which did.

import { describe, expect, it } from "vitest";
import {
	BLOCKED_REASONS,
	blockedPaths,
	summarizeBlocked,
	type BlockedLabels,
	type BlockedPath,
} from "../sync/blocked";

const labels: BlockedLabels = {
	reason: (r) => `reason-${r}`,
	group: (r) => `{n} group-${r}`,
	headline: (n) => `${n} not synced`,
	listed: "Not synced: ",
	folded: (n) => ` and ${n} more`,
	othersUnaffected: "Others unaffected.",
};

describe("summarizeBlocked", () => {
	it("is empty when nothing is blocked", () => {
		const s = summarizeBlocked([], labels);
		expect(s).toEqual({
			count: 0,
			headline: "",
			detail: "",
			files: [],
		});
	});

	it("names every path while there are few", () => {
		const b: BlockedPath[] = [
			{ path: "a/big.zip", reason: "oversized" },
			{ path: "b/unreadable.psd", reason: "readFailed" },
		];
		const s = summarizeBlocked(b, labels);
		expect(s.count).toBe(2);
		expect(s.headline).toBe("2 not synced");
		expect(s.detail).toContain("a/big.zip（reason-oversized）");
		expect(s.detail).toContain("b/unreadable.psd（reason-readFailed）");
		expect(s.detail).toContain("Others unaffected.");
		// nothing folded away at this size
		expect(s.detail).not.toContain("group-");
	});

	it("folds the tail into per-reason counts", () => {
		const b: BlockedPath[] = [
			{ path: "1.zip", reason: "oversized" },
			{ path: "2.zip", reason: "oversized" },
			{ path: "3.zip", reason: "oversized" },
			{ path: "4.bin", reason: "readFailed" },
		];
		const s = summarizeBlocked(b, labels);
		expect(s.count).toBe(4);
		expect(s.detail).toContain("and 4 more");
		expect(s.detail).toContain("3 group-oversized");
		expect(s.detail).toContain("1 group-readFailed");
	});

	it("keeps BLOCKED_REASONS order in the folded groups", () => {
		const b: BlockedPath[] = [
			{ path: "a", reason: "caseConflict" },
			{ path: "b", reason: "readFailed" },
			{ path: "c", reason: "oversized" },
			{ path: "d", reason: "oversized" },
		];
		const s = summarizeBlocked(b, labels);
		const oversizedAt = s.detail.indexOf("group-oversized");
		const readAt = s.detail.indexOf("group-readFailed");
		const caseAt = s.detail.indexOf("group-caseConflict");
		expect(oversizedAt).toBeGreaterThan(-1);
		expect(oversizedAt).toBeLessThan(readAt);
		expect(readAt).toBeLessThan(caseAt);
	});

	it("de-duplicates the same path+reason (a round can rediscover it)", () => {
		const b: BlockedPath[] = [
			{ path: "a.zip", reason: "oversized" },
			{ path: "a.zip", reason: "oversized" },
		];
		expect(summarizeBlocked(b, labels).count).toBe(1);
	});

	it("keeps the same path twice when the reasons differ", () => {
		const b: BlockedPath[] = [
			{ path: "a.zip", reason: "oversized" },
			{ path: "a.zip", reason: "readFailed" },
		];
		expect(summarizeBlocked(b, labels).count).toBe(2);
	});
});

describe("blockedPaths", () => {
	it("lists each path once", () => {
		expect(
			blockedPaths([
				{ path: "a", reason: "oversized" },
				{ path: "a", reason: "readFailed" },
				{ path: "b", reason: "oversized" },
			]),
		).toEqual(["a", "b"]);
	});
});

describe("BLOCKED_REASONS", () => {
	it("covers every reason the engine can emit", () => {
		// a new reason must be added here or the folded summary drops it
		expect([...BLOCKED_REASONS].sort()).toEqual([
			"caseConflict",
			"oversized",
			"readFailed",
			"remoteOversized",
		]);
	});
});
