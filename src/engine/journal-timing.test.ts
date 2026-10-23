// Unit-level confirmation of the journal-timing issue: a fresh device has
// no journalId, so readJournal returns nothing until an audit discovers it.
import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, fileExists } from "../../test-support/device";
import type { ConfigSyncSettings } from "../config/filter";

const noConfig = (): ConfigSyncSettings => ({
	enabled: false, app: false, appearance: false, appearanceData: false,
	hotkey: false, corePlugin: false, corePluginData: false,
	communityPlugin: false, communityPluginData: false,
});

describe("fresh device journal timing", () => {
	it("B learns about A's nested page on its FIRST round via the journal", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { configSync: noConfig() });
		a.write("Home.md", "home\n");
		a.write("Sub/Child.md", "child\n");
		await a.sync();

		// B is a fresh device: journalId is unknown to it
		const b = makeDevice(fake, rootId, "b", { configSync: noConfig() });
		const rb = await b.sync();

		console.log(`B first round: created=${rb.created} entries=${Object.keys(b.state.entries).length}`);
		console.log(`B journalId=${b.state.journalId} journalSeen=${b.state.journalSeen?.length ?? 0}`);
		expect(rb.failed).toBe(0);
		// The nested page must be present after ONE round, not two.
		expect(fileExists(b, "Home.md")).toBe(true);
		expect(fileExists(b, "Sub/Child.md")).toBe(true);
	});
});
