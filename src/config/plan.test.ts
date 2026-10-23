import { describe, expect, it } from "vitest";
import { planConfig, type ConfigBase } from "./plan";

const B = (sha = "s0"): ConfigBase => ({ pageId: "p1", sha });
const L = (sha: string) => ({ exists: true as const, sha });
const R = (sha: string) => ({ sha, pageId: "p1" });

function types(base: Record<string, ConfigBase>, local: any, remote: any) {
	return planConfig(base, local, remote).map((a) => `${a.type}:${a.rel}`);
}

describe("planConfig", () => {
	it("local-only change → pushUpdate", () => {
		expect(
			types({ "a.json": B() }, { "a.json": L("s1") }, { "a.json": R("s0") }),
		).toEqual(["pushUpdate:a.json"]);
	});

	it("remote-only change → pullWrite", () => {
		expect(
			types({ "a.json": B() }, { "a.json": L("s0") }, { "a.json": R("s1") }),
		).toEqual(["pullWrite:a.json"]);
	});

	it("both changed, same sha → updateBase", () => {
		expect(
			types({ "a.json": B() }, { "a.json": L("s2") }, { "a.json": R("s2") }),
		).toEqual(["updateBase:a.json"]);
	});

	it("both changed, differ → conflictWrite (remote wins)", () => {
		expect(
			types({ "a.json": B() }, { "a.json": L("sL") }, { "a.json": R("sR") }),
		).toEqual(["conflictWrite:a.json"]);
	});

	it("bootstrap: same sha → updateBase; differ → conflictWrite", () => {
		expect(types({}, { "a.json": L("s") }, { "a.json": R("s") })).toEqual([
			"updateBase:a.json",
		]);
		expect(types({}, { "a.json": L("x") }, { "a.json": R("y") })).toEqual([
			"conflictWrite:a.json",
		]);
	});

	it("local-only file → pushCreate; remote-only → pullWrite", () => {
		expect(types({}, { "a.json": L("s") }, {})).toEqual([
			"pushCreate:a.json",
		]);
		expect(types({}, {}, { "a.json": R("s") })).toEqual([
			"pullWrite:a.json",
		]);
	});

	it("local deleted & remote unchanged → trashRemote", () => {
		expect(
			types({ "a.json": B() }, {}, { "a.json": R("s0") }),
		).toEqual(["trashRemote:a.json"]);
	});

	it("local deleted & remote absent (unevaluated) → still trashRemote", () => {
		expect(types({ "a.json": B() }, {}, {})).toEqual([
			"trashRemote:a.json",
		]);
	});

	it("local deleted & remote modified → pullWrite (modification wins)", () => {
		expect(types({ "a.json": B() }, {}, { "a.json": R("s1") })).toEqual([
			"pullWrite:a.json",
		]);
	});

	it("remote deleted & local unchanged → trashLocal", () => {
		expect(
			types(
				{ "a.json": B() },
				{ "a.json": L("s0") },
				{ "a.json": { deleted: true } },
			),
		).toEqual(["trashLocal:a.json"]);
	});

	it("remote deleted & local modified → pushCreate (recreate)", () => {
		expect(
			types(
				{ "a.json": B() },
				{ "a.json": L("s1") },
				{ "a.json": { deleted: true } },
			),
		).toEqual(["pushCreate:a.json"]);
	});

	it("remote absent & local unchanged → updateBase (not a deletion)", () => {
		expect(types({ "a.json": B() }, { "a.json": L("s0") }, {})).toEqual([
			"updateBase:a.json",
		]);
	});

	it("unchanged → updateBase", () => {
		expect(
			types({ "a.json": B() }, { "a.json": L("s0") }, { "a.json": R("s0") }),
		).toEqual(["updateBase:a.json"]);
	});
});
