import { describe, expect, it } from "vitest";
import {
	buildMultipart,
	partCount,
	partSlice,
	PART_SIZE_BYTES,
	uploadBytes,
} from "./upload";
import { FakeNotion } from "../../test-support/fake-notion";
import { NotionClient } from "../notion/client";

// expect(a).toEqual(b) on large typed arrays is pathological in vitest —
// compare manually.
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

describe("multi-part helpers", () => {
	it("partCount: sizes → part counts", () => {
		expect(partCount(1)).toBe(1);
		expect(partCount(PART_SIZE_BYTES)).toBe(1);
		expect(partCount(PART_SIZE_BYTES + 1)).toBe(2);
		expect(partCount(25 * 1024 * 1024)).toBe(3);
	});

	it("partSlice: sequential slices cover the whole blob", () => {
		const bytes = new Uint8Array(PART_SIZE_BYTES * 2 + 123);
		for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
		const p1 = partSlice(bytes, 1);
		const p2 = partSlice(bytes, 2);
		const p3 = partSlice(bytes, 3);
		expect(p1.length).toBe(PART_SIZE_BYTES);
		expect(p2.length).toBe(PART_SIZE_BYTES);
		expect(p3.length).toBe(123);
		const joined = new Uint8Array(bytes.length);
		joined.set(p1, 0);
		joined.set(p2, PART_SIZE_BYTES);
		joined.set(p3, PART_SIZE_BYTES * 2);
		expect(sameBytes(joined, bytes)).toBe(true);
	});

	it("buildMultipart includes extra text fields before the file part", () => {
		const data = new Uint8Array([1, 2, 3]);
		const buf = new Uint8Array(
			buildMultipart("f.bin", "application/octet-stream", data, "BND", {
				part_number: "2",
			}),
		);
		const text = new TextDecoder().decode(buf);
		expect(text).toContain('name="part_number"');
		expect(text).toContain("\r\n\r\n2\r\n");
		expect(text).toContain('name="file"; filename="f.bin"');
		expect(text).toContain("--BND--");
	});
});

describe("uploadBytes", () => {
	const client = (fake: FakeNotion) =>
		new NotionClient({
			token: "t",
			request: fake.request,
			minIntervalMs: 0,
			maxRetries: 0,
		});

	it("small file: single_part create + one send", async () => {
		const fake = new FakeNotion();
		const bytes = new TextEncoder().encode("hello");
		const parts: [number, number][] = [];
		const id = await uploadBytes(
			client(fake),
			"a.txt",
			"text/plain",
			bytes,
			(p, n) => parts.push([p, n]),
		);
		expect(parts).toEqual([[1, 1]]);
		const up = fake.uploads.get(id)!;
		expect(up.mode).toBe("single_part");
		expect(sameBytes(up.bytes!, bytes)).toBe(true);
		expect(
			fake.reqLog.filter((r) => r.path.includes("/send")).length,
		).toBe(1);
		expect(fake.reqLog.some((r) => r.path.includes("complete"))).toBe(false);
	});

	it("large file: multi_part create + N sends + complete, bytes intact", async () => {
		const fake = new FakeNotion();
		const size = PART_SIZE_BYTES * 2 + 100; // 3 parts
		const bytes = new Uint8Array(size);
		for (let i = 0; i < size; i++) bytes[i] = i % 253;
		const parts: [number, number][] = [];
		const id = await uploadBytes(
			client(fake),
			"big.zip",
			"application/zip",
			bytes,
			(p, n) => parts.push([p, n]),
		);
		expect(parts).toEqual([
			[1, 3],
			[2, 3],
			[3, 3],
		]);
		const up = fake.uploads.get(id)!;
		expect(up.mode).toBe("multi_part");
		expect(up.parts.size).toBe(3);
		expect(sameBytes(up.bytes!, bytes)).toBe(true); // concatenated on complete
		const sends = fake.reqLog.filter((r) => r.path.includes("/send"));
		expect(sends.length).toBe(3);
		expect(fake.reqLog.some((r) => r.path.includes("complete"))).toBe(true);
	});
});
