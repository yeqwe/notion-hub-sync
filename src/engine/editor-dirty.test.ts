// An open editor holds a stale document that Obsidian saves back over a
// pull (the "phone undid my desktop edit" incident). apply must defer any
// write to a file the user is still typing in; the IO must not leave a
// stale buffer behind after writing.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, type Device } from "../../test-support/device";
import type { VaultIO } from "../sync/vault-io";

/** Wrap the device's IO so `editorDirty` always reports a dirty buffer —
 * the "note is open with unsaved typing" state. `restore()` puts the
 * original back. */
function wrapEditorDirty(d: Device): { restore(): void } {
	const inner = d.deps.vault;
	d.deps.vault = Object.assign(
		Object.create(Object.getPrototypeOf(inner)),
		inner,
		{ editorDirty: async () => true },
	) as VaultIO;
	return {
		restore() {
			d.deps.vault = inner;
		},
	};
}

describe("editorDirty", () => {
	it("pullContent defers while the note is open with unsaved changes", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		const b = makeDevice(fake, rootId, "b");
		a.write("n.md", "v1\n");
		await a.sync();
		await b.sync();
		const id = Object.entries(b.state.entries).find(
			([, e]) => e.path === "n.md",
		)![0];

		const dirty = wrapEditorDirty(b);
		fake.humanEdit(id, "v2\n");
		const r = await b.sync();
		// deferred, NOT written over: the user's buffer is preserved and the
		// remote edit waits for a clean editor.
		expect(r.skipped).toBeGreaterThanOrEqual(1);
		expect(r.failed).toBe(0);
		expect(b.read("n.md")).toBe("v1\n");

		// the user saved — the deferred pull lands on the next round
		dirty.restore();
		const r2 = await b.sync();
		expect(r2.failed).toBe(0);
		expect(b.read("n.md")).toBe("v2\n");
	});
});
