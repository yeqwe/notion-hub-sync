// A remote file above the configured size limit must be refused BEFORE it
// is downloaded — and reported as blocked, not as a failure. Pulling a
// 2 GB attachment just to notice it is over the limit has already spent
// the bandwidth, and on a phone the memory.
//
// The engine cannot catch this as an ordinary error either: a failure is
// retried every round (and red every round), while "too large" is a
// deliberate policy skip that the user has to see and act on.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice } from "../../test-support/device";

function setup() {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a");
	const b = makeDevice(fake, rootId, "b");
	return { fake, a, b };
}

describe("remote size limit", () => {
	it("uploads fine below the limit", async () => {
		const { a, b } = setup();
		a.deps.engine = { ...a.deps.engine, maxFileSizeMB: 1 };
		a.write("small.png", "tiny");
		expect((await a.sync()).failed).toBe(0);
		expect((await b.sync()).failed).toBe(0);
		expect(b.read("small.png")).toBe("tiny");
	});

	it("blocks a local file above the limit with the oversized reason", async () => {
		const { a } = setup();
		a.deps.engine = { ...a.deps.engine, maxFileSizeMB: 1 };
		// 2 MB of content against a 1 MB limit
		a.write("big.bin", "x".repeat(2 * 1024 * 1024));
		const r = await a.sync();
		// a policy skip is not a failure — it must not turn the round red
		expect(r.failed).toBe(0);
		const blocked = r.blocked.find((b) => b.path === "big.bin");
		expect(blocked?.reason).toBe("oversized");
		expect(blocked?.detail).toContain("MB");
		// and the local file is untouched
		expect(a.read("big.bin").length).toBe(2 * 1024 * 1024);
	});

	it("does not trash the local copy of a blocked oversized file", async () => {
		const { a } = setup();
		a.deps.engine = { ...a.deps.engine, maxFileSizeMB: 1 };
		a.write("big.bin", "x".repeat(2 * 1024 * 1024));
		await a.sync();
		// second round: still skipped, still present, still not deleted
		const r2 = await a.sync();
		expect(r2.failed).toBe(0);
		expect(a.read("big.bin").length).toBe(2 * 1024 * 1024);
	});
});
