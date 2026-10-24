// Regression: a push must not overwrite a remote edit that landed after this
// round's snapshot.
//
// `pushContent` is planned from "local changed, remote unchanged". Even with a
// structural scan every round, the scan is a SNAPSHOT: an edit that lands
// between the scan and this device's write would be discarded by a blind
// overwrite. A push is irreversible for the other device, so the applier
// re-reads the page right before writing and defers when it moved.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, type Device } from "../../test-support/device";

function setup() {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	return {
		fake,
		a: makeDevice(fake, rootId, "a"),
		b: makeDevice(fake, rootId, "b"),
	};
}

function onlyId(d: Device): string {
	return Object.keys(d.state.entries)[0]!;
}

function remoteMarkdown(fake: FakeNotion, id: string): string {
	return fake.pages.get(id)!.markdown;
}

describe("push defers when the remote moved under it", () => {
	it("a remote edit arriving after the snapshot is not overwritten", async () => {
		const { fake, a, b } = setup();
		a.write("n.md", "v1\n");
		await a.sync();
		await b.sync();
		const id = onlyId(a);
		expect(b.read("n.md")).toBe("v1\n");

		// The desktop edits and syncs its round FIRST (so the remote moves),
		// but this device's snapshot was already taken: `remoteEdited` on B
		// still names the OLD timestamp, which is exactly the state the guard
		// is there to catch.
		b.write("n.md", "phone version\n");
		const bEntry = b.state.entries[id]!;
		const staleStamp = bEntry.remoteEdited;
		a.write("n.md", "edited on the desktop\n");
		await a.sync();

		// Force B's round to start from a stale view of the page: the entry
		// still believes the remote is at `staleStamp`.
		bEntry.remoteEdited = staleStamp;

		const rb = await b.sync();
		expect(rb.failed).toBe(0);

		// The desktop's version survives on the remote…
		expect(remoteMarkdown(fake, id)).toContain("edited on the desktop");
		expect(remoteMarkdown(fake, id)).not.toContain("phone version");

		// …and the next round converges on it, no upload.
		const r2 = await b.sync();
		expect(r2.failed).toBe(0);
		expect(b.read("n.md")).toContain("edited on the desktop");
	});

	it("an undisturbed push still goes through in the same round", async () => {
		const { fake, a, b } = setup();
		a.write("n.md", "v1\n");
		await a.sync();
		await b.sync();
		const id = onlyId(a);

		b.write("n.md", "phone version\n");
		const rb = await b.sync();
		expect(rb.updated).toBe(1);
		expect(rb.skipped).toBe(0);
		expect(remoteMarkdown(fake, id)).toContain("phone version");
	});
});
