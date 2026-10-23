// Reserved system containers (🧾 journal / 🗄️ history / ⚙️ config) live
// directly under the sync root. A device that has never synced — or one
// whose state was reset — must find the existing page instead of creating
// a second one, otherwise every round after it forks the tree: two
// journals means half the changes are never read, two history containers
// means version pages land in a page the other device treats as content.

import type { NotionClient } from "../notion/client";
import type { SyncState } from "../sync/state";
import { listChildPages } from "../sync/tree";

export interface ReservedSpec {
	title: string;
	icon: string;
}

const hex = (id: string): string => id.replace(/-/g, "").toLowerCase();

/** Find an existing reserved page under the root by icon, then by title
 * prefix (the emoji may be dropped when a page is created by hand). */
export async function findReservedPage(
	client: NotionClient,
	state: SyncState,
	spec: ReservedSpec,
): Promise<string | null> {
	const want = spec.title.trimStart();
	for (const child of await listChildPages(client, state.rootPageId)) {
		const title = child.title.trimStart();
		if (title === want || title.startsWith(spec.icon)) {
			return hex(child.id);
		}
	}
	return null;
}

/** Recorded id → return it; unrecorded → look it up → only create when the
 * root really has no such page. Never creates the same container twice. */
export async function ensureReservedPage(
	deps: {
		client: NotionClient;
		state: SyncState;
		/** absent → the caller persists state itself (config sync). */
		saveState?: () => Promise<void>;
	},
	spec: ReservedSpec,
	recorded: string | undefined,
	adopt: (id: string) => void,
): Promise<string> {
	if (recorded) return recorded;
	const found = await findReservedPage(deps.client, deps.state, spec);
	if (found) {
		adopt(found);
		await deps.saveState?.();
		return found;
	}
	const res = await deps.client.request<{ id: string }>("POST", "/pages", {
		parent: { page_id: deps.state.rootPageId },
		properties: { title: { title: [{ text: { content: spec.title } }] } },
		icon: { type: "emoji", emoji: spec.icon },
	});
	const id = hex(res.id);
	adopt(id);
	await deps.saveState?.();
	return id;
}
