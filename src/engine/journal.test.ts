import { describe, expect, it } from "vitest";
import { NotionClient } from "../notion/client";
import { FakeNotion } from "../../test-support/fake-notion";
import { emptyState } from "../sync/state";
import { ensureJournal, readJournal, writeJournal } from "./journal";

function deps(fake: FakeNotion, rootId: string, deviceId: string) {
	const state = emptyState(rootId);
	return {
		client: new NotionClient({
			token: "x",
			request: fake.request,
			minIntervalMs: 0,
			maxRetries: 0,
		}),
		state,
		saveState: async () => {},
		deviceId,
	};
}

describe("journal", () => {
	it("round-trips ops; other device sees candidates", async () => {
		const fake = new FakeNotion();
		const root = fake.humanCreatePage("", "root");
		const a = deps(fake, root, "aaaaaaaa-1111");
		const b = deps(fake, root, "bbbbbbbb-2222");
		await writeJournal(a, [
			{ o: "n", id: "ab".repeat(16) },
			{ o: "c", id: "cd".repeat(16), s: "sha" },
		]);
		expect(a.state.journalId).toBeTruthy();
		const r = await readJournal(
			b.client,
			a.state.journalId,
			"bbbbbbbb",
			[],
			false,
		);
		expect(r.remoteChanged).toBe(true);
		expect(r.candidateIds.sort()).toEqual([
			"ab".repeat(16),
			"cd".repeat(16),
		]);
		expect(r.newSeen.length).toBe(1);
	});

	it("ignores own-device ops but marks them seen", async () => {
		const fake = new FakeNotion();
		const root = fake.humanCreatePage("", "root");
		const a = deps(fake, root, "aaaaaaaa-1111");
		await writeJournal(a, [{ o: "t", id: "ee".repeat(16) }]);
		const r = await readJournal(
			a.client,
			a.state.journalId,
			"aaaaaaaa",
			[],
			false,
		);
		expect(r.remoteChanged).toBe(false);
		expect(r.candidateIds).toEqual([]);
		expect(r.newSeen.length).toBe(1);
	});

	it("malformed blocks are seen-and-ignored", async () => {
		const fake = new FakeNotion();
		const root = fake.humanCreatePage("", "root");
		const a = deps(fake, root, "aaaaaaaa-1111");
		const jid = await ensureJournal(a);
		await a.client.request("PATCH", `/blocks/${jid}/children`, {
			position: { type: "start" },
			children: [
				{
					type: "paragraph",
					paragraph: {
						rich_text: [{ type: "text", text: { content: "not json" } }],
					},
				},
			],
		});
		const r = await readJournal(a.client, jid, "zzzzzzzz", [], false);
		expect(r.candidateIds).toEqual([]);
		expect(r.newSeen.length).toBe(1);
	});

	it("reports a gap when seen ids fell off the end", async () => {
		const fake = new FakeNotion();
		const root = fake.humanCreatePage("", "root");
		const a = deps(fake, root, "aaaaaaaa-1111");
		const jid = await ensureJournal(a);
		// 6 pages of 100 = > READ_PAGES(5) × 100 blocks
		for (let i = 0; i < 6; i++) {
			const children = Array.from({ length: 100 }, () => ({
				type: "paragraph",
				paragraph: {
					rich_text: [
						{ type: "text", text: { content: "{}" } },
					],
				},
			}));
			await a.client.request("PATCH", `/blocks/${jid}/children`, {
				position: { type: "end" },
				children,
			});
		}
		const r = await readJournal(
			a.client,
			jid,
			"bbbbbbbb",
			["never-seen-block"],
			false,
		);
		expect(r.gap).toBe(true);
	});
});
