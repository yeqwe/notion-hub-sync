// Reserved-container handling: two devices must share ONE 🧾/🗄️/⚙️ page,
// and a stray version page (hex32 title, file block on it) that ends up in
// the vault tree must never be pulled in as a note.

import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { fileExists, makeDevice } from "../../test-support/device";
import { ensureReservedPage } from "../sync/reserved";
import { findReservedPage } from "../sync/reserved";

const norm = (id: string): string => id.replace(/-/g, "").toLowerCase();

function setup() {
	const fake = new FakeNotion();
	const rootId = fake.humanCreatePage("", "root");
	return { fake, rootId };
}

describe("reserved containers", () => {
	it("a second device adopts the existing 🗄️ page instead of creating one", async () => {
		const { fake, rootId } = setup();
		const a = makeDevice(fake, rootId, "a");
		const b = makeDevice(fake, rootId, "b");

		// device A creates the history container
		const idA = await ensureReservedPage(
			a.deps,
			{ title: "🗄️ 同步历史 (notion-hub-sync)", icon: "🗄️" },
			a.state.historyRootId,
			(id) => {
				a.state.historyRootId = id;
			},
		);

		// device B has no record of it yet
		expect(b.state.historyRootId).toBeUndefined();
		const idB = await ensureReservedPage(
			b.deps,
			{ title: "🗄️ 同步历史 (notion-hub-sync)", icon: "🗄️" },
			b.state.historyRootId,
			(id) => {
				b.state.historyRootId = id;
			},
		);

		expect(idB).toBe(idA);
		const containers = [...fake.pages.values()].filter((p) =>
			p.title.startsWith("🗄️"),
		);
		expect(containers).toHaveLength(1);
	});

	it("finds a reserved page by title prefix when the icon is missing", async () => {
		const { fake, rootId } = setup();
		const page = fake.humanCreatePage(rootId, "⚙️ Obsidian 设置 (notion-hub-sync)");
		const state = { rootPageId: norm(rootId), entries: {} } as never;
		const client = makeDevice(fake, rootId, "a").deps.client;
		expect(norm(page)).toBe(
			await findReservedPage(client, state, {
				title: "⚙️ Obsidian 设置 (notion-hub-sync)",
				icon: "⚙️",
			}),
		);
	});

	it("stray version pages in the tree are never pulled as notes", async () => {
		const { fake, rootId } = setup();
		const a = makeDevice(fake, rootId, "a");
		a.write("Note.md", "hello\n");
		await a.sync();

		const note = [...fake.pages.values()].find((p) => p.title === "Note")!;
		// a version page that ended up in the vault tree: hex32 title of an
		// existing page, file block inside, no icon
		const strayId = fake.humanCreatePage(rootId, norm(note.id), null);
		const stray = fake.pages.get(strayId)!;
		fake.allBlocksFor(stray.id).push({
			id: "strayfileblock",
			parentId: stray.id,
			type: "file",
			data: {
				type: "file_upload",
				caption: [{ type: "text", text: { content: "Note.md" } }],
			},
			inTrash: false,
			createdTime: 0,
		});

		const b = makeDevice(fake, rootId, "b");
		const r = await b.sync(true);
		expect(r.failed).toBe(0);

		// not pulled into the vault …
		expect(fileExists(b, `${norm(note.id)}.md`)).toBe(false);
		expect(fileExists(b, `${norm(note.id)}`)).toBe(false);
		// … and taken out of the tree
		expect(fake.pages.get(stray.id)?.inTrash).toBe(true);
	});
});
