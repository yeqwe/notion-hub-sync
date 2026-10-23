// Offline two-device config-dir sync tests.

import { describe, expect, it } from "vitest";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, type Device } from "../../test-support/device";

function cwrite(d: Device, rel: string, content: string): void {
	const abs = join(d.dir, ".obsidian", ...rel.split("/"));
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
}

function cread(d: Device, rel: string): string {
	return readFileSync(join(d.dir, ".obsidian", ...rel.split("/")), "utf8");
}

function cexists(d: Device, rel: string): boolean {
	return existsSync(join(d.dir, ".obsidian", ...rel.split("/")));
}

/** Relative paths of every conflict copy anywhere under `.obsidian`. */
function findConflictCopy(deviceDir: string): string | undefined {
	const root = join(deviceDir, ".obsidian");
	const walk = (rel: string): string[] => {
		const abs = rel ? join(root, rel) : root;
		if (!existsSync(abs)) return [];
		const out: string[] = [];
		for (const e of readdirSync(abs, { withFileTypes: true })) {
			const p = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) out.push(...walk(p));
			else if (p.includes("conflict")) out.push(p);
		}
		return out;
	};
	return walk("")[0];
}

function setup() {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a");
	const b = makeDevice(fake, rootId, "b");
	return { fake, rootId, a, b };
}

function pageTitles(fake: FakeNotion): string[] {
	return [...fake.pages.values()].map((p) => p.title);
}

describe("config-dir sync (offline)", () => {
	it("a. bootstrap config files reach B; reload flag set", async () => {
		const { a, b } = setup();
		cwrite(a, "appearance.json", '{"theme":"dark"}');
		cwrite(a, "snippets/x.css", "body{}");
		cwrite(a, "hotkeys.json", "{}");
		const ra = await a.sync();
		expect(ra.failed).toBe(0);
		const rb = await b.sync();
		expect(rb.failed).toBe(0);
		expect(rb.configWritten).toBe(true);
		expect(cread(b, "appearance.json")).toBe('{"theme":"dark"}');
		expect(cread(b, "snippets/x.css")).toBe("body{}");
		expect(cread(b, "hotkeys.json")).toBe("{}");
	});

	it("b. edit on B propagates to A", async () => {
		const { a, b } = setup();
		cwrite(a, "appearance.json", "v1");
		await a.sync();
		await b.sync();
		cwrite(b, "appearance.json", "v2");
		await b.sync();
		await a.sync();
		expect(cread(a, "appearance.json")).toBe("v2");
	});

	it("c. both edit differently → remote wins, local-only copy", async () => {
		const { a, b } = setup();
		cwrite(a, "appearance.json", "base");
		await a.sync();
		await b.sync();
		cwrite(a, "appearance.json", "A wins");
		cwrite(b, "appearance.json", "B loses");
		await a.sync();
		await b.sync(); // B conflicts → remote wins locally
		expect(cread(b, "appearance.json")).toBe("A wins");
		// the copy lives in our own plugin dir — never in configDir root,
		// where it would look like an ordinary setting
		const copy = findConflictCopy(b.dir);
		expect(copy).toBeTruthy();
		expect(copy!.startsWith("plugins/notion-hub-sync/")).toBe(true);
		// B pushes nothing for the copy; A never sees it
		await b.sync();
		await a.sync();
		expect(cread(a, "appearance.json")).toBe("A wins");
		expect(findConflictCopy(a.dir)).toBeUndefined();
	});

	it("b2. re-serialised JSON (key order/whitespace only) is not a change", async () => {
		const { a, b } = setup();
		cwrite(a, "appearance.json", '{"theme":"dark","baseFontSize":16}');
		await a.sync();
		await b.sync();
		expect(cread(b, "appearance.json")).toBe(
			'{"theme":"dark","baseFontSize":16}',
		);
		// the app rewrites the file with a different key order + formatting
		cwrite(
			b,
			"appearance.json",
			'{\n  "baseFontSize": 16,\n  "theme": "dark"\n}',
		);
		const rb = await b.sync();
		// no push, no conflict, nothing written — the content is the same
		expect(rb.conflictCopies).toEqual([]);
		expect(rb.configWritten).toBeFalsy();
		await a.sync();
		expect(findConflictCopy(a.dir)).toBeUndefined();
		expect(findConflictCopy(b.dir)).toBeUndefined();
	});

	it("b3. a real JSON value change still syncs", async () => {
		const { a, b } = setup();
		cwrite(a, "appearance.json", '{"theme":"dark","baseFontSize":16}');
		await a.sync();
		await b.sync();
		cwrite(b, "appearance.json", '{"baseFontSize":17,"theme":"dark"}');
		await b.sync();
		await a.sync();
		expect(cread(a, "appearance.json")).toBe(
			'{"baseFontSize":17,"theme":"dark"}',
		);
	});

	it("d. delete snippet on A → removed on B", async () => {
		const { a, b } = setup();
		cwrite(a, "snippets/x.css", "body{}");
		await a.sync();
		await b.sync();
		expect(cexists(b, "snippets/x.css")).toBe(true);
		const Node = await import("../../test-support/node-config-io");
		void Node;
		// delete locally on A
		const { unlinkSync } = await import("node:fs");
		unlinkSync(join(a.dir, ".obsidian", "snippets", "x.css"));
		await a.sync();
		await b.sync();
		expect(cexists(b, "snippets/x.css")).toBe(false);
	});

	it("e. never-synced files are never uploaded", async () => {
		const { fake, a, b } = setup();
		cwrite(a, "workspace.json", "{}");
		cwrite(a, "sync.json", "{}");
		cwrite(a, "plugins/notion-hub-sync/data.json", '{"token":"secret"}');
		cwrite(a, "plugins/other/data.json", "{}");
		cwrite(a, "community-plugins.json", "[]");
		await a.sync();
		await b.sync();
		const titles = pageTitles(fake);
		for (const t of titles) {
			expect(t).not.toContain("workspace");
			expect(t).not.toContain("notion-hub-sync");
			expect(t).not.toContain("plugins/");
		}
		expect(titles).not.toContain("community-plugins.json");
		expect(cexists(b, "workspace.json")).toBe(false);
		expect(cexists(b, "plugins/notion-hub-sync/data.json")).toBe(false);
	});
});

describe("request budget", () => {
	it("idle round and one-config-edit round stay cheap", async () => {
		const { fake, a, b } = setup();
		cwrite(a, "appearance.json", "v1");
		await a.sync();
		await b.sync();
		fake.reqLog.length = 0;
		await b.sync();
		// journal read + search + round-robin/system page fetches only
		expect(fake.reqLog.length).toBeLessThanOrEqual(6);
		fake.reqLog.length = 0;
		cwrite(b, "appearance.json", "v2");
		await b.sync();
		// idle + upload create/send + delete old block + append + journal write
		expect(fake.reqLog.length).toBeLessThanOrEqual(12);
	});

	it("one-note edit round stays cheap", async () => {
		const { fake, a, b } = setup();
		writeFileSync(join(a.dir, "N.md"), "x\n");
		await a.sync();
		await b.sync();
		writeFileSync(join(b.dir, "N.md"), "y\n");
		fake.reqLog.length = 0;
		await b.sync();
		// +1 vs before: the reserved-container lookup lists the root's
		// children once instead of blindly creating a second 🗄️ page
		// (that duplicate later got pulled back as vault notes).
		expect(fake.reqLog.length).toBeLessThanOrEqual(15);
	});
});
