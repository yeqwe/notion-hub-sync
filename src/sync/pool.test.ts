// Byte-budgeted concurrency. The bug this prevents is invisible in unit
// tests and fatal on a phone: three 200 MB uploads at once is 600 MB of
// live buffers, because the old pool bounded the *count*, not the bytes.

import { describe, expect, it } from "vitest";
import {
	CONTENT_BUDGET,
	createYieldControl,
	mapConcurrent,
	runPool,
	sizeOrUnknown,
} from "../sync/pool";

/** Let queued promise callbacks settle between assertions. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("mapConcurrent", () => {
	it("returns results in input order regardless of completion order", async () => {
		const out = await mapConcurrent([3, 1, 2], 3, async (n) => {
			await new Promise((r) => setTimeout(r, n));
			return n * 10;
		});
		expect(out).toEqual([30, 10, 20]);
	});

	it("never exceeds the item limit", async () => {
		let active = 0;
		let peak = 0;
		await mapConcurrent([1, 2, 3, 4, 5, 6], 2, async () => {
			active++;
			peak = Math.max(peak, active);
			await flush();
			active--;
		});
		expect(peak).toBe(2);
	});

	it("never exceeds the byte budget", async () => {
		const sizes = [10, 10, 10, 10];
		let activeBytes = 0;
		let peak = 0;
		await mapConcurrent(
			sizes.map((size, i) => ({ size, i })),
			8,
			async (item) => {
				activeBytes += item.size;
				peak = Math.max(peak, activeBytes);
				await flush();
				activeBytes -= item.size;
			},
			{ sizeOf: (it) => it.size, budgetBytes: 25 },
		);
		expect(peak).toBeLessThanOrEqual(25);
	});

	it("lets one oversized item run alone instead of deadlocking", async () => {
		let active = 0;
		let peak = 0;
		const items = [{ size: 5 }, { size: 1000 }, { size: 5 }];
		await mapConcurrent(
			items,
			4,
			async () => {
				active++;
				peak = Math.max(peak, active);
				await flush();
				active--;
			},
			{ sizeOf: (it) => it.size, budgetBytes: 50 },
		);
		// the 1000-byte item is admitted only when nothing else is running
		expect(peak).toBe(1);
	});

	it("a single rejection rejects the whole call and stops admission", async () => {
		let started = 0;
		await expect(
			mapConcurrent([1, 2, 3, 4, 5, 6, 7, 8], 1, async (n) => {
				started++;
				if (n === 2) throw new Error("boom");
				return n;
			}),
		).rejects.toThrow("boom");
		// limit=1 → item 3 never starts
		expect(started).toBe(2);
	});

	it("handles an empty list", async () => {
		expect(await mapConcurrent([], 3, async () => 1)).toEqual([]);
	});

	it("works without a budget (plain limit)", async () => {
		expect(await mapConcurrent([1, 2], 3, async (n) => n)).toEqual([1, 2]);
	});
});

describe("runPool", () => {
	it("visits every item", async () => {
		const seen: number[] = [];
		await runPool([1, 2, 3], 2, async (n) => {
			seen.push(n);
		});
		expect(seen.sort()).toEqual([1, 2, 3]);
	});
});

describe("sizeOrUnknown", () => {
	it("falls back for missing or nonsense sizes", () => {
		expect(sizeOrUnknown(1024)).toBe(1024);
		expect(sizeOrUnknown(0)).toBe(0);
		expect(sizeOrUnknown(undefined)).toBeGreaterThan(0);
		expect(sizeOrUnknown(-1)).toBeGreaterThan(0);
		expect(sizeOrUnknown(Number.NaN)).toBeGreaterThan(0);
	});
});

describe("CONTENT_BUDGET", () => {
	it("mobile is tighter than desktop", () => {
		expect(CONTENT_BUDGET.mobile).toBeLessThan(CONTENT_BUDGET.desktop);
	});
});

describe("createYieldControl", () => {
	it("yields on the item counter", async () => {
		let yields = 0;
		const yc = createYieldControl(async () => {
			yields++;
		});
		for (let i = 0; i < 10; i++) await yc.tick(5, 10_000);
		expect(yields).toBe(2); // after items 5 and 10
	});

	it("yields on elapsed time even with a big counter interval", async () => {
		let yields = 0;
		const yc = createYieldControl(async () => {
			yields++;
		});
		await new Promise((r) => setTimeout(r, 60));
		await yc.tick(1_000_000, 50);
		expect(yields).toBe(1);
	});
});
