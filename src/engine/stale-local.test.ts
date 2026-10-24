// Regression: a device whose local file ROLLED BACK to an older version must
// not push that version over a newer remote.
//
// Reported failure: "I edited on the desktop, slept, opened the phone in the
// morning, and the phone synced the OLD version up." The phone's disk had
// reverted (iCloud replaying the vault, a second sync tool, an editor
// restoring a buffer after iOS killed the app) — a *new* mtime and different
// bytes, so every mtime/size heuristic read it as "the user edited this".
// The planner then saw "local changed, remote unchanged" and pushed.
//
// The fix: an entry remembers the shas it has superseded when its local file
// was overwritten with REMOTE content. A local hash matching one of those is a
// rollback, so the planner restores from Notion instead of uploading.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, type Device } from "../../test-support/device";

function setup() {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a");
	const b = makeDevice(fake, rootId, "b");
	return { fake, rootId, a, b };
}

function onlyId(d: Device): string {
	return Object.keys(d.state.entries)[0]!;
}

function remoteMarkdown(fake: FakeNotion, id: string): string {
	return fake.pages.get(id)!.markdown;
}

describe("stale local copy must not overwrite a newer remote", () => {
	it("phone's disk reverting to the previous version is restored, not pushed", async () => {
		const { fake, a, b } = setup();
		a.write("n.md", "v1\n");
		await a.sync();
		await b.sync();
		const id = onlyId(a);
		expect(b.read("n.md")).toBe("v1\n");

		// Desktop edits, pushes; the phone pulls the new version.
		a.write("n.md", "v2 from desktop\n");
		await a.sync();
		await b.sync();
		expect(b.read("n.md")).toBe("v2 from desktop\n");

		// The phone's disk silently reverts to v1 (new mtime, old bytes).
		await new Promise((r) => setTimeout(r, 20));
		b.write("n.md", "v1\n");

		const rb = await b.sync();
		// Remote must still hold the desktop's version.
		expect(remoteMarkdown(fake, id)).toContain("v2 from desktop");
		// …and the phone's file is restored, not left stale.
		expect(b.read("n.md")).toBe("v2 from desktop\n");
		expect(rb.updated).toBe(1);
		expect(rb.warnings.join("\n")).toMatch(/older version/);

		// The desktop must not see a "remote changed" round out of this.
		const ra = await a.sync();
		expect(ra.updated).toBe(0);
		expect(a.read("n.md")).toBe("v2 from desktop\n");
	});

	it("rollback of a BINARY file is restored too", async () => {
		const { fake, a, b } = setup();
		a.write("f.bin", "AAA");
		await a.sync();
		await b.sync();
		const id = onlyId(a);

		a.write("f.bin", "BBBBB");
		await a.sync();
		await b.sync();
		expect(b.read("f.bin")).toBe("BBBBB");

		await new Promise((r) => setTimeout(r, 20));
		b.write("f.bin", "AAA");

		await b.sync();
		expect(b.read("f.bin")).toBe("BBBBB");
		expect(remoteMarkdown(fake, id)).not.toContain("AAA");
	});

	it("a real local edit still pushes (the guard is not a lock)", async () => {
		const { fake, a, b } = setup();
		a.write("n.md", "v1\n");
		await a.sync();
		await b.sync();
		const id = onlyId(a);

		a.write("n.md", "v2\n");
		await a.sync();
		await b.sync();

		// A genuinely new version — not one the base ever held.
		b.write("n.md", "v3 phone edit\n");
		await b.sync();
		expect(remoteMarkdown(fake, id)).toContain("v3 phone edit");
		expect(b.read("n.md")).toBe("v3 phone edit\n");
	});

	it("rolling back past content the user pushed is still a push (not a rollback)", async () => {
		const { fake, a, b } = setup();
		a.write("n.md", "v1\n");
		await a.sync();
		await b.sync();
		const id = onlyId(a);

		// B authors v2 itself and pushes it. v1 was never a REMOTE-sourced
		// version for B, so going back to v1 is a deliberate revert and must
		// sync (otherwise "undo my own edit" would silently stop working).
		b.write("n.md", "v2 phone authored\n");
		await b.sync();
		expect(remoteMarkdown(fake, id)).toContain("v2 phone authored");

		b.write("n.md", "v1\n");
		await b.sync();
		expect(remoteMarkdown(fake, id)).toContain("v1");
	});
});
