// Resume after an interrupted round: mid-apply checkpoints persist the
// created-page entries, so the next round converges without conflicts
// or duplicate Notion pages.

import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice } from "../../test-support/device";
import type { SyncState } from "../sync/state";

describe("interrupted sync resume", () => {
	it("checkpointed state resumes without duplicates or conflicts", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");

		a.write("Dir/note1.md", "one\n");
		a.write("Dir/note2.md", "two\n");
		a.write("note3.md", "three\n");
		writeFileSync(
			join(a.dir, "Dir", "f.png"),
			new Uint8Array([9, 8, 7]),
		);

		// emulate on-disk persistence: every saveState snapshots → disk.
		// `dead` simulates the process being killed (Obsidian closed).
		let disk: SyncState | null = null;
		let dead = false;
		a.deps.saveState = async () => {
			if (!dead) {
				disk = JSON.parse(
					JSON.stringify(a.deps.state),
				) as SyncState;
			}
		};

		// after the 2nd page create, every request fails and saves stop —
		// the app is "dead" from that point on
		const origReq = a.deps.client.request.bind(a.deps.client);
		let creates = 0;
		a.deps.client.request = (async (
			method: "GET" | "POST" | "PATCH" | "DELETE",
			path: string,
			body?: unknown,
		) => {
			if (dead) throw new Error("connection lost");
			if (method === "POST" && path === "/pages") {
				creates++;
				if (creates > 2) {
					dead = true;
					throw new Error("connection lost");
				}
			}
			return origReq(method, path, body);
		}) as typeof a.deps.client.request;

		const r1 = await a.sync();
		expect(r1.failed).toBeGreaterThan(0);
		expect(disk).toBeTruthy();
		// the checkpoint before death captured the created pages
		expect(Object.keys(disk!.entries as object).length).toBeGreaterThan(0);
		expect(disk!.lastSyncAt).toBeUndefined(); // final save never ran

		// "reopen": restore state from the last persisted snapshot
		for (const k of Object.keys(a.deps.state) as Array<
			keyof SyncState
		>) {
			delete a.deps.state[k];
		}
		Object.assign(a.deps.state, disk);
		a.deps.client.request = origReq;
		dead = false;

		const r2 = await a.sync();
		expect(r2.failed).toBe(0);
		expect(r2.conflictCopies).toEqual([]);

		// every local file/folder maps to exactly one state entry
		const paths = Object.values(a.deps.state.entries).map((e) => e.path);
		for (const p of [
			"Dir",
			"Dir/note1.md",
			"Dir/note2.md",
			"Dir/f.png",
			"note3.md",
		]) {
			expect(paths.filter((x) => x === p).length).toBe(1);
		}

		// no duplicate pages (same title under the same parent)
		const seen = new Set<string>();
		for (const p of fake.pages.values()) {
			const key = `${p.parentId}|${p.title}`;
			expect(seen.has(key)).toBe(false);
			seen.add(key);
		}
	});
});
