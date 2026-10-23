import { describe, expect, it } from "vitest";
import {
	NotionApiError,
	NotionClient,
	type HttpRequest,
	type HttpResponse,
} from "./client";

interface Harness {
	client: NotionClient;
	calls: HttpRequest[];
	sleeps: number[];
	setNow(value: number): void;
}

function makeHarness(
	handler: (req: HttpRequest, callIndex: number) => Promise<HttpResponse>,
	options: { minIntervalMs?: number; maxRetries?: number } = {},
): Harness {
	const calls: HttpRequest[] = [];
	const sleeps: number[] = [];
	let now = 0;
	const client = new NotionClient({
		token: "secret-token",
		request: async (req) => {
			calls.push(req);
			return handler(req, calls.length - 1);
		},
		sleep: async (ms) => {
			sleeps.push(ms);
			now += ms;
		},
		now: () => now,
		minIntervalMs: options.minIntervalMs ?? 340,
		maxRetries: options.maxRetries ?? 4,
	});
	return {
		client,
		calls,
		sleeps,
		setNow: (value) => {
			now = value;
		},
	};
}

const ok = (json: unknown): HttpResponse => ({
	status: 200,
	json,
	headers: {},
});

describe("NotionClient", () => {
	it("sends correct headers and URL", async () => {
		const h = makeHarness(async () => ok({}));
		await h.client.request("GET", "/users/me");
		expect(h.calls).toHaveLength(1);
		const call = h.calls[0] as HttpRequest;
		expect(call.url).toBe("https://api.notion.com/v1/users/me");
		expect(call.method).toBe("GET");
		expect(call.headers.Authorization).toBe("Bearer secret-token");
		expect(call.headers["Notion-Version"]).toBe("2026-03-11");
		expect(call.headers["Content-Type"]).toBe("application/json");
		expect(call.body).toBeUndefined();
	});

	it("serializes JSON bodies", async () => {
		const h = makeHarness(async () => ok({}));
		await h.client.request("POST", "/pages", { parent: { id: "x" } });
		expect(h.calls[0]?.body).toBe(
			JSON.stringify({ parent: { id: "x" } }),
		);
	});

	it("spaces consecutive requests by minIntervalMs", async () => {
		const h = makeHarness(async () => ok({}), { minIntervalMs: 340 });
		await h.client.request("GET", "/a");
		await h.client.request("GET", "/b");
		expect(h.sleeps).toEqual([340]);
	});

	it("waits Retry-After seconds on 429 then succeeds", async () => {
		const h = makeHarness(async (_req, i) =>
			i === 0
				? {
						status: 429,
						json: {},
						headers: { "Retry-After": "2" },
					}
				: ok({ done: true }),
		);
		const res = await h.client.request<{ done: boolean }>("GET", "/x");
		expect(res.done).toBe(true);
		expect(h.calls).toHaveLength(2);
		expect(h.sleeps).toEqual([2000]);
	});

	it("backs off exponentially on 5xx then succeeds", async () => {
		const h = makeHarness(async (_req, i) =>
			i < 2 ? { status: 503, json: {}, headers: {} } : ok({ done: true }),
		);
		const res = await h.client.request<{ done: boolean }>("GET", "/x");
		expect(res.done).toBe(true);
		expect(h.calls).toHaveLength(3);
		// exponential with ±10% jitter: assert the shape, not exact ms — a
		// fixed value would make two devices on the same interval retry in
		// lock step, which is the bug the jitter exists to avoid
		expect(h.sleeps).toHaveLength(2);
		expect(h.sleeps[0]).toBeGreaterThanOrEqual(900);
		expect(h.sleeps[0]).toBeLessThanOrEqual(1100);
		expect(h.sleeps[1]).toBeGreaterThanOrEqual(1800);
		expect(h.sleeps[1]).toBeLessThanOrEqual(2200);
	});

	it("throws after maxRetries retries on persistent 500", async () => {
		const h = makeHarness(
			async () => ({ status: 500, json: {}, headers: {} }),
			{ maxRetries: 2 },
		);
		await expect(h.client.request("GET", "/x")).rejects.toMatchObject({
			status: 500,
		});
		expect(h.calls).toHaveLength(3);
		expect(h.sleeps).toHaveLength(2);
	});

	it("throws NotionApiError immediately on 400 without retrying", async () => {
		const h = makeHarness(async () => ({
			status: 400,
			json: {
				code: "validation_error",
				message: "body failed validation",
			},
			headers: {},
		}));
		const err = await h.client.request("GET", "/x").catch((e) => e);
		expect(err).toBeInstanceOf(NotionApiError);
		expect(err).toMatchObject({
			status: 400,
			code: "validation_error",
			message: "body failed validation",
		});
		expect(h.calls).toHaveLength(1);
		expect(h.sleeps).toEqual([]);
	});

	it("retries thrown network errors then surfaces network_error", async () => {
		const h = makeHarness(
			async () => {
				throw new Error("socket hangup");
			},
			{ maxRetries: 1 },
		);
		const err = await h.client.request("GET", "/x").catch((e) => e);
		expect(err).toBeInstanceOf(NotionApiError);
		expect(err).toMatchObject({
			status: 0,
			code: "network_error",
			message: "socket hangup",
		});
		expect(h.calls).toHaveLength(2);
		expect(h.sleeps).toEqual([1000]);
	});
});
