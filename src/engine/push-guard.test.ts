// Regression: a push must not overwrite a remote edit that landed after this
// round's snapshot.
//
// `pushContent` is planned from "local changed, remote unchanged". In an
// incremental round most entries were never looked at, so "remote unchanged"
// is an assumption. When it is wrong — the desktop edited the same note while
// the phone was still starting up — the push silently discards that work. The
// applier therefore re-reads the page's last_edited_time right before
// overwriting and defers the push when it moved.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, type Device } from "../../test-support/device";
import type { RequestFn } from "../notion/client";

function setup(request?: RequestFn) {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a", { request });
	const b = makeDevice(fake, rootId, "b", { request });
	return { fake, rootId, a, b };
}

function onlyId(d: Device): string {
	return Object.keys(d.state.entries)[0]!;
}

function remoteMarkdown(fake: FakeNotion, id: string): string {
	return fake.pages.get(id)!.markdown;
}

describe("push defers when the remote moved under it", () => {
	it("a remote edit arriving mid-round is not overwritten", async () => {
		let fake!: FakeNotion;
		// The snapshot phase reads the page (GET /pages) and then its markdown;
		// the push guard is the SECOND GET /pages for that page. Landing the
		// foreign edit between them is exactly the race a phone sees when it
		// wakes up after the desktop already synced.
		let pageGets = 0;
		const racy: RequestFn = async (req) => {
			const path = req.url.replace(/^.*\/v1/, "");
			if (req.method === "GET" && /^\/pages\/[0-9a-f]{32}$/.test(path)) {
				pageGets++;
				if (pageGets === 2) {
					const page = [...fake.pages.values()].find(
						(p) => p.title === "n",
					);
					if (page) fake.humanEdit(page.id, "edited on the desktop\n");
				}
			}
			return fake.request(req);
		};
		const s = setup(racy);
		fake = s.fake;
		const { a, b } = s;

		a.write("n.md", "v1\n");
		await a.sync();
		await b.sync();
		const id = onlyId(a);
		expect(b.read("n.md")).toBe("v1\n");

		// The phone edits locally; the desktop's edit lands mid-round.
		b.write("n.md", "phone version\n");
		const rb = await b.sync();
		expect(pageGets).toBeGreaterThanOrEqual(2);

		// The desktop's version survives on the remote…
		expect(remoteMarkdown(fake, id)).toContain("edited on the desktop");
		expect(remoteMarkdown(fake, id)).not.toContain("phone version");
		expect(rb.failed).toBe(0);

		// Next round converges on the remote version, no upload.
		const r2 = await b.sync();
		expect(r2.failed).toBe(0);
		expect(b.read("n.md")).toContain("edited on the desktop");
		expect(remoteMarkdown(fake, id)).toContain("edited on the desktop");
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
