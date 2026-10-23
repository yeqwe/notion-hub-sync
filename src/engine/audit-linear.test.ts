// Real-world shape: deeply nested tree + a human change. The snapshot must
// converge without the audit exploding into an O(vault) walk.
import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { fileExists, makeDevice } from "../../test-support/device";
import type { ConfigSyncSettings } from "../config/filter";

const noConfig = (): ConfigSyncSettings => ({
	enabled: false, app: false, appearance: false, appearanceData: false,
	hotkey: false, corePlugin: false, corePluginData: false,
	communityPlugin: false, communityPluginData: false,
});

function walkCalls(fake: FakeNotion, rootId: string): number {
	const norm = (id: string) => id.replace(/-/g, "").toLowerCase();
	return fake.reqLog.filter(
		(r) =>
			r.method === "GET" &&
			/^\/blocks\/[^/]+\/children/.test(r.path) &&
			norm(r.path.split("/")[2]!) !== norm(rootId) &&
			!r.path.includes("00000008"), // journal
	).length;
}

describe("audit stays linear on a nested tree", () => {
	it("full audit on a 3-level tree does not walk every parent", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
		// 3 levels, 4 folders x 5 notes = 20 notes + 4 folders
		for (let f = 0; f < 4; f++) {
			for (let n = 0; n < 5; n++) a.write(`L1${f}/n${n}.md`, `v${f}-${n}\n`);
			for (let s = 0; s < 2; s++) {
				a.write(`L1${f}/sub${s}/deep.md`, `deep ${f}-${s}\n`);
			}
		}
		await a.sync();
		const entries = Object.keys(a.state.entries).length;
		expect(entries).toBeGreaterThan(20);

		fake.reqLog.length = 0;
		const r = await a.sync(true);
		expect(r.failed).toBe(0);
		const calls = walkCalls(fake, rootId);
		console.log(`nested audit: entries=${entries} walkCalls=${calls} totalReq=${fake.reqLog.length}`);
		// Only the root listing is allowed; everything else must come from /search
		expect(calls).toBeLessThanOrEqual(1);
	});

	it("a human add deep in the tree is still found", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
		for (let f = 0; f < 3; f++) a.write(`L1${f}/n0.md`, `v${f}\n`);
		await a.sync();

		const l10 = [...fake.pages.values()].find((p) => p.title === "L10")!;
		fake.humanCreatePage(l10.id, "deep-new");

		const r = await a.sync(true);
		expect(r.failed).toBe(0);
		expect(fileExists(a, "L10/deep-new.md")).toBe(true);
	});

	it("a human delete deep in the tree is still found", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
		a.write("D/deep/n1.md", "one\n");
		a.write("D/deep/n2.md", "two\n");
		await a.sync();

		const n1 = [...fake.pages.values()].find((p) => p.title === "n1")!;
		fake.humanTrash(n1.id);

		const r = await a.sync(true);
		expect(r.failed).toBe(0);
		expect(fileExists(a, "D/deep/n1.md")).toBe(false);
		expect(fileExists(a, "D/deep/n2.md")).toBe(true);
	});
});
