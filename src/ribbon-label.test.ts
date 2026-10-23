// Ribbon tooltip wording. The tooltip is the only always-visible surface,
// so it must state the most urgent fact and never claim "all synced" when
// something is outstanding.

import { describe, expect, it } from "vitest";
import { getStrings } from "./i18n";

const en = getStrings("en");
const zh = getStrings("zh-CN");

const idle = {
	paused: false,
	syncing: false,
	failed: false,
	blocked: 0,
	conflicts: 0,
	pending: 0,
	lastSync: "14:32",
};

describe("ribbonLabel", () => {
	it("says all synced when nothing is outstanding", () => {
		expect(en.ribbonLabel(idle)).toContain("all synced");
		expect(zh.ribbonLabel(idle)).toContain("已全部同步");
	});

	it("reports paused first", () => {
		const tip = en.ribbonLabel({ ...idle, paused: true, pending: 5 });
		expect(tip).toContain("paused");
		// paused does not suppress the pending count — both matter
		expect(tip).toContain("5 changes pending");
		// but it must not claim everything is fine
		expect(tip).not.toContain("all synced");
	});

	it("never says all synced while files are blocked", () => {
		const tip = en.ribbonLabel({ ...idle, blocked: 2 });
		expect(tip).toContain("2 files not synced");
		expect(tip).not.toContain("all synced");
	});

	it("never says all synced while conflicts exist", () => {
		const tip = en.ribbonLabel({ ...idle, conflicts: 1 });
		expect(tip).toContain("1 unresolved conflict");
		expect(tip).not.toContain("all synced");
	});

	it("never says all synced while changes are pending", () => {
		const tip = en.ribbonLabel({ ...idle, pending: 3 });
		expect(tip).toContain("3 changes pending");
		expect(tip).not.toContain("all synced");
	});

	it("mentions a failed round", () => {
		expect(en.ribbonLabel({ ...idle, failed: true })).toContain("failures");
	});

	it("always keeps the last-sync time, and never lets it replace a status", () => {
		const tip = en.ribbonLabel({ ...idle, lastSync: "09:15" });
		expect(tip).toContain("09:15");
		expect(tip).toContain("all synced");
	});

	it("handles a device that has never synced", () => {
		const tip = en.ribbonLabel({ ...idle, lastSync: null });
		expect(tip).not.toContain("all synced");
		expect(tip).toBe("Notion Hub Sync");
	});

	it("uses singular forms correctly", () => {
		expect(en.ribbonLabel({ ...idle, blocked: 1 })).toContain("1 file not synced");
		expect(en.ribbonLabel({ ...idle, blocked: 2 })).toContain("2 files not synced");
		expect(en.ribbonLabel({ ...idle, conflicts: 1 })).toContain(
			"1 unresolved conflict",
		);
		expect(en.ribbonLabel({ ...idle, conflicts: 2 })).toContain(
			"2 unresolved conflicts",
		);
	});
});

describe("blocked wording", () => {
	it("has a phrase for every reason the engine can emit", () => {
		for (const reason of [
			"oversized",
			"remoteOversized",
			"readFailed",
			"caseConflict",
		]) {
			expect(en.blockedReason(reason)).not.toBe(reason);
			expect(zh.blockedReason(reason)).not.toBe(reason);
		}
	});

	it("falls back to the raw code for an unknown reason", () => {
		expect(en.blockedReason("somethingNew")).toBe("somethingNew");
	});
});

describe("phase wording", () => {
	it("names every phase the engine emits", () => {
		for (const [key, expected] of [
			["hashing", "Hashing"],
			["walking", "Walking"],
			["evaluating", "Checking"],
			["downloading", "Downloading"],
			["uploading", "Uploading"],
			["applying", "Applying"],
			["config", "settings"],
		] as const) {
			expect(en.phaseStage(key, null, null)).toContain(expected);
		}
	});

	it("appends counters only when both numbers are known", () => {
		expect(en.phaseStage("downloading", 3, 10)).toBe("Downloading 3/10");
		expect(en.phaseStage("downloading", null, 10)).toBe("Downloading");
		expect(en.phaseStage("downloading", 3, null)).toBe("Downloading");
	});
});
