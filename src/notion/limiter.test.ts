// Limiter tests: ≤3 in flight, ≥334ms start spacing for API requests,
// 429 pauses all new starts, signed downloads bypass spacing.
import { describe, expect, it } from "vitest";
import { NotionClient, type HttpRequest, type HttpResponse } from "./client";

function fakeClock() {
	let now = 0;
	return {
		now: () => now,
		sleep: (ms: number) => {
			now += ms;
			return Promise.resolve();
		},
	};
}

describe("NotionClient limiter", () => {
	it("starts at most 3 in flight and spaces api starts ≥334ms", async () => {
		const clock = fakeClock();
		const starts: number[] = [];
		let inFlight = 0;
		let maxInFlight = 0;
		const client = new NotionClient({
			token: "t",
			now: clock.now,
			sleep: clock.sleep,
			request: async (r: HttpRequest) => {
				starts.push(clock.now());
				inFlight++;
				maxInFlight = Math.max(maxInFlight, inFlight);
				// hold the slot across several microtask turns so queued
				// tasks can actually overlap
				for (let i = 0; i < 3; i++) {
					await new Promise((res) => setTimeout(res, 0));
				}
				inFlight--;
				return { status: 200, json: { ok: true }, headers: {} };
			},
		});
		const tasks = Array.from({ length: 7 }, (_, i) =>
			client.request("GET", `/pages/p${i}`),
		);
		await Promise.all(tasks);
		expect(maxInFlight).toBe(3);
		for (let i = 1; i < starts.length; i++) {
			expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(334);
		}
	});

	it("429 pauses ALL new starts until Retry-After", async () => {
		const clock = fakeClock();
		const starts: Array<{ t: number; url: string }> = [];
		let first = true;
		const client = new NotionClient({
			token: "t",
			now: clock.now,
			sleep: clock.sleep,
			maxRetries: 1,
			request: async (r: HttpRequest): Promise<HttpResponse> => {
				starts.push({ t: clock.now(), url: r.url });
				if (first) {
					first = false;
					return {
						status: 429,
						json: {},
						headers: { "retry-after": "2" },
					};
				}
				return { status: 200, json: {}, headers: {} };
			},
		});
		const t0 = client.request("GET", "/pages/a");
		const t1 = client.request("GET", "/pages/b");
		const t2 = client.request("GET", "/pages/c");
		await Promise.all([t0, t1, t2]);
		// a: start@0 → 429 → retry ≥2000. b may have started before the 429
		// was observed (that's fine). No start after the 429 may precede
		// blockedUntil: the first post-429 start is a's own retry ≥2000,
		// and any request started at t > 334 saw the 429 already.
		const aStarts = starts.filter((s) => s.url.endsWith("/a"));
		expect(aStarts[0]!.t).toBe(0);
		expect(aStarts[1]!.t).toBeGreaterThanOrEqual(2000);
		for (const s of starts) {
			if (s.t > 334) expect(s.t).toBeGreaterThanOrEqual(2000);
		}
	});

	it("signed downloads bypass api spacing but share the cap", async () => {
		const clock = fakeClock();
		const starts: Array<{ t: number; url: string }> = [];
		const client = new NotionClient({
			token: "t",
			now: clock.now,
			sleep: clock.sleep,
			minIntervalMs: 334,
			request: async (r: HttpRequest) => {
				starts.push({ t: clock.now(), url: r.url });
				return {
					status: 200,
					json: {},
					headers: {},
					arrayBuffer: new ArrayBuffer(2),
				};
			},
		});
		// enqueue api request first, then two downloads, then another api
		// request — downloads must start at t=0 despite the pending
		// api-spacing window (they still share the 3-concurrent cap).
		await Promise.all([
			client.request("GET", "/pages/x"), // start@0
			client.download("https://s3.example/signed-a"), // immediate
			client.download("https://s3.example/signed-b"), // immediate
			client.request("GET", "/pages/y"), // spaced ≥334
		]);
		const y = starts.find((s) => s.url.endsWith("/pages/y"))!;
		const dls = starts.filter((s) => s.url.includes("s3.example"));
		expect(y.t).toBeGreaterThanOrEqual(334);
		expect(dls.every((d) => d.t === 0)).toBe(true);
	});
});
