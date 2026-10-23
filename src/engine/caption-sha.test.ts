// Media-caption content sha: uploads stamp `sha256:<hex>` into the file
// block's caption so remote evaluation can hash-check a file page without
// downloading it. Exact: every content replacement makes a NEW media
// block, so a caption sha can never be stale.

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { fileExists, makeDevice, type Device } from "../../test-support/device";
import { sha256Hex } from "../sync/hashes";
import { captionSha } from "../sync/upload";

const FILE_BYTES = new Uint8Array([1, 2, 3, 4, 5, 250]);

function writeBinary(a: Device, path: string, bytes: Uint8Array): void {
	const abs = join(a.dir, ...path.split("/"));
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, bytes);
}

function readBinary(a: Device, path: string): Uint8Array {
	return new Uint8Array(readFileSync(join(a.dir, ...path.split("/"))));
}

/** count client.download calls (real file bytes) from this point on. */
function countDownloads(a: Device): () => number {
	const orig = a.deps.client.download.bind(a.deps.client);
	let n = 0;
	a.deps.client.download = ((
		url: string,
		opts?: { sizeHintBytes?: number },
	) => {
		n++;
		return orig(url, opts);
	}) as typeof a.deps.client.download;
	return () => n;
}

async function mediaBlockOf(device: Device, pageId: string) {
	const res = await device.deps.client.request<{
		results?: Array<{ id: string; type: string; [k: string]: unknown }>;
	}>("GET", `/blocks/${pageId}/children?page_size=100`);
	return (res.results ?? []).find((b) => b.type === "image");
}

function pageByTitle(fake: FakeNotion, title: string) {
	return [...fake.pages.values()].find((p) => p.title === title);
}

describe("media caption sha", () => {
	it("upload stamps sha256 in the media caption", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		writeBinary(a, "F/x.png", FILE_BYTES);
		await a.sync();

		const page = pageByTitle(fake, "x.png")!;
		expect(page).toBeTruthy();
		const media = await mediaBlockOf(a, page.id);
		expect(media).toBeTruthy();

		const inner = media![media!.type] as {
			caption?: Array<{ text?: { content?: string } }>;
		};
		const full = inner.caption?.map((s) => s.text?.content).join("");
		expect(full?.startsWith("x.png")).toBe(true);
		expect(full).toContain(`sha256:${await sha256Hex(FILE_BYTES)}`);
		expect(captionSha(media!)).toBe(await sha256Hex(FILE_BYTES));
	});

	it("re-match links via caption with zero downloads", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		writeBinary(a, "F/x.png", FILE_BYTES);
		await a.sync();

		// fresh-state device with the same local file
		const b = makeDevice(fake, rootId, "b");
		writeBinary(b, "F/x.png", FILE_BYTES);
		const downloads = countDownloads(b);
		fake.reqLog.length = 0; // count only B's requests
		const r = await b.sync();

		expect(r.failed).toBe(0);
		expect(r.conflictCopies).toEqual([]);
		expect(downloads()).toBe(0);
		// no re-upload either
		expect(
			fake.reqLog
				.filter((q) => q.method === "POST" && q.path === "/file_uploads")
				.length,
		).toBe(0);
		// linked: the existing remote page is B's entry for the path
		const page = pageByTitle(fake, "x.png")!;
		expect(
			b.deps.state.entries[page.id.replace(/-/g, "").toLowerCase()]?.path,
		).toBe("F/x.png");
	});

	it("pull lazily downloads exactly once", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		writeBinary(a, "F/x.png", FILE_BYTES);
		await a.sync();

		const b = makeDevice(fake, rootId, "b");
		const downloads = countDownloads(b);
		const r = await b.sync();
		expect(r.failed).toBe(0);
		expect(downloads()).toBe(1);
		expect(fileExists(b, "F/x.png")).toBe(true);
		expect(readBinary(b, "F/x.png")).toEqual(FILE_BYTES);
	});

	it("replacement produces a new block id + new caption sha", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		const b = makeDevice(fake, rootId, "b");
		writeBinary(a, "F/x.png", FILE_BYTES);
		writeBinary(b, "F/x.png", FILE_BYTES);
		await a.sync();
		await b.sync(); // links via caption

		const newBytes = new Uint8Array([9, 9, 9]);
		writeBinary(a, "F/x.png", newBytes);
		const ra = await a.sync();
		expect(ra.failed).toBe(0);

		const downloads = countDownloads(b);
		const rb = await b.sync();
		expect(rb.failed).toBe(0);
		expect(rb.conflictCopies).toEqual([]);
		expect(downloads()).toBe(1); // one lazy pull download
		expect(readBinary(b, "F/x.png")).toEqual(newBytes);
	});

	it("caption without sha falls back to download", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		writeBinary(a, "F/x.png", FILE_BYTES);
		await a.sync();

		// strip the sha → legacy/human-uploaded page
		const page = pageByTitle(fake, "x.png")!;
		const block = [...fake.blocks.values()].find(
			(bl) => bl.parentId === page.id,
		)!;
		const inner = block.data[block.type] as { caption?: unknown };
		inner.caption = [{ type: "text", text: { content: "x.png" } }];

		const b = makeDevice(fake, rootId, "b");
		writeBinary(b, "F/x.png", FILE_BYTES);
		const downloads = countDownloads(b);
		const r = await b.sync();
		expect(r.failed).toBe(0);
		expect(downloads()).toBe(1);
		expect(r.conflictCopies).toEqual([]);
	});
});
