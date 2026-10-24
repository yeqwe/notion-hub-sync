// A config page that cannot be READ is not a config page that is GONE.
//
// The config tree used to answer every failed request — 403, 429, timeout,
// expired signed download URL, 5xx — with `remote[rel] = { deleted: true }`.
// `planConfig` reads "remote deleted + local unchanged" as `trashLocal`, so a
// single failed request put the user's `.obsidian/*.json` in the trash and
// dropped its base entry.
//
// The note tree already had this rule (`probePage`: "could not ask" is not
// "not there"). These tests pin the same rule on the config side, and the
// 404 control case proves real deletions still propagate.

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, type Device } from "../../test-support/device";
import { NotionApiError } from "../notion/client";

function cwrite(d: Device, rel: string, content: string): void {
	const abs = join(d.dir, ".obsidian", ...rel.split("/"));
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
}

function cexists(d: Device, rel: string): boolean {
	return existsSync(join(d.dir, ".obsidian", ...rel.split("/")));
}

/** One device, one config file already on the remote. */
async function bootstrapped() {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	const a = makeDevice(fake, rootId, "a");
	cwrite(a, "appearance.json", '{"theme":"dark"}');
	const r = await a.sync();
	expect(r.failed).toBe(0);
	const pageId = a.state.config?.["appearance.json"]?.pageId;
	expect(pageId).toBeTruthy();
	return { fake, a, pageId: pageId! };
}

/** Wrap the device's client so one request shape fails with `err`. */
function failRequests(
	a: Device,
	match: (method: string, path: string) => boolean,
	err: NotionApiError,
): void {
	const orig = a.deps.client.request.bind(a.deps.client);
	a.deps.client.request = (async (
		method: "GET" | "POST" | "PATCH" | "DELETE",
		path: string,
		body?: unknown,
	) => {
		if (match(method, path)) throw err;
		return orig(method, path, body);
	}) as typeof a.deps.client.request;
}

describe("config sync: unreadable is not deleted", () => {
	it("a 403 on the page does not trash the local settings file", async () => {
		const { a, pageId } = await bootstrapped();
		failRequests(
			a,
			(m, p) => m === "GET" && p === `/pages/${pageId}`,
			new NotionApiError(403, "restricted_resource", "no access"),
		);

		const r = await a.sync(true); // full round → config audit re-reads it

		expect(r.failed).toBe(0);
		expect(cexists(a, "appearance.json")).toBe(true);
		expect(a.state.config?.["appearance.json"]?.pageId).toBe(pageId);
	});

	it("an unreadable page body does not trash the local settings file", async () => {
		const { a, pageId } = await bootstrapped();
		// the page is there; only its blocks are out of reach (expired signed
		// URL, timeout, 5xx)
		failRequests(
			a,
			(m, p) => m === "GET" && p.startsWith(`/blocks/${pageId}/children`),
			new NotionApiError(500, "internal_server_error", "boom"),
		);

		const r = await a.sync(true);

		expect(r.failed).toBe(0);
		expect(cexists(a, "appearance.json")).toBe(true);
		expect(a.state.config?.["appearance.json"]?.pageId).toBe(pageId);
	});

	it("a 404 still means deleted — the local file is trashed", async () => {
		const { a, pageId } = await bootstrapped();
		failRequests(
			a,
			(m, p) => m === "GET" && p === `/pages/${pageId}`,
			new NotionApiError(404, "object_not_found", "gone"),
		);

		const r = await a.sync(true);

		expect(r.failed).toBe(0);
		expect(cexists(a, "appearance.json")).toBe(false);
		expect(a.state.config?.["appearance.json"]).toBeUndefined();
	});
});
