// Scope through the whole engine: an out-of-scope path must produce NO
// action at all — no push, no pull, and above all no trash.
//
// The dangerous shape is the bootstrap one: device B has never synced, so
// it has no base for the excluded file. If scope were only applied to the
// *push* side, B would see "remote has a page, local does not" and delete
// it on the other device — or, worse, see "local has a file, remote does
// not" and treat the absence as a deletion and trash the local copy.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice } from "../../test-support/device";
import { defaultScope } from "../sync/scope";

function setup() {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a");
	const b = makeDevice(fake, rootId, "b");
	return { fake, a, b };
}

describe("sync scope", () => {
	it("never uploads an excluded folder", async () => {
		const { a } = setup();
		a.deps.engine = { ...a.deps.engine, scope: { ...defaultScope(), excludedFolders: ["Private"] } };
		a.write("Private/secret.md", "nope\n");
		a.write("Public/ok.md", "yes\n");

		const r = await a.sync();
		expect(r.failed).toBe(0);
		// only the in-scope note produced a page
		expect(Object.values(a.state.entries).map((e) => e.path).sort()).toEqual([
			"Public",
			"Public/ok.md",
		]);
	});

	it("does not delete the remote copy of an excluded path", async () => {
		const { a, b } = setup();
		// A syncs everything → the folder exists in Notion
		a.write("Private/secret.md", "keep me\n");
		await a.sync();
		expect(a.state.lastReport?.failed ?? 0).toBe(0);

		// A is then scoped to exclude it. The page must survive: "not in
		// scope" is not "deleted".
		a.deps.engine = {
			...a.deps.engine,
			scope: { ...defaultScope(), excludedFolders: ["Private"] },
		};
		a.write("Public/new.md", "x\n");
		const r = await a.sync();
		expect(r.failed).toBe(0);

		// B (unscoped) still sees the excluded note
		await b.sync();
		expect(b.read("Private/secret.md")).toBe("keep me\n");
	});

	it("does not pull an excluded path to a device that never had it", async () => {
		const { a, b } = setup();
		a.write("Private/secret.md", "from A\n");
		a.write("Public/ok.md", "shared\n");
		await a.sync();

		b.deps.engine = {
			...b.deps.engine,
			scope: { ...defaultScope(), excludedFolders: ["Private"] },
		};
		const r = await b.sync();
		expect(r.failed).toBe(0);
		// the in-scope note arrives, the excluded one does not
		expect(b.read("Public/ok.md")).toBe("shared\n");
		expect(() => b.read("Private/secret.md")).toThrow();
		// and B did not delete A's page
		await a.sync();
		expect(a.read("Private/secret.md")).toBe("from A\n");
	});

	it("skips a switched-off file type without deleting anything", async () => {
		const { a, b } = setup();
		a.write("a.zip", "binary-ish\n");
		a.write("n.md", "note\n");
		a.deps.engine = {
			...a.deps.engine,
			// "other" off by default
			scope: defaultScope(),
		};
		const r = await a.sync();
		expect(r.failed).toBe(0);
		expect(Object.values(a.state.entries).map((e) => e.path)).toEqual(["n.md"]);

		// a second round must not resurrect or trash it either
		const r2 = await a.sync();
		expect(r2.failed).toBe(0);
		expect(a.read("a.zip")).toBe("binary-ish\n");

		// unscoped device sees only the note
		await b.sync();
		expect(b.read("n.md")).toBe("note\n");
		expect(() => b.read("a.zip")).toThrow();
	});

	it("reports an unreadable local file as blocked, not failed", async () => {
		const { a } = setup();
		const scope = { ...defaultScope(), excludedFolders: [] as string[] };
		scope.excludedFolders = ["blocked"];
		a.deps.engine = { ...a.deps.engine, scope };
		// a path inside the excluded folder is out of scope; it must show up
		// nowhere as a change or an error
		a.write("blocked/x.md", "x\n");
		const r = await a.sync();
		expect(r.failed).toBe(0);
		expect(r.blocked).toEqual([]);
	});
});
