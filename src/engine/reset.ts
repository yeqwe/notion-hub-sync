// Reset helpers: wipe this device's sync record (re-match by path next
// round) and/or trash every page under the Notion root (fresh re-upload).

import type { NotionClient } from "../notion/client";
import type { SyncState } from "../sync/state";
import { listChildPages } from "../sync/tree";

/** In-place reset: keep only version + rootPageId; drop every entry. */
export function resetState(state: SyncState): void {
	for (const k of Object.keys(state)) {
		if (k !== "version" && k !== "rootPageId") {
			delete (state as unknown as Record<string, unknown>)[k];
		}
	}
	state.entries = {};
}

/** Trash all direct children of the root page (a trashed parent takes its
 * whole subtree). Returns the number of pages trashed. */
export async function clearRemote(
	deps: { client: NotionClient; state: SyncState },
	onProgress?: (done: number, total: number) => void,
): Promise<number> {
	const children = await listChildPages(
		deps.client,
		deps.state.rootPageId,
	);
	const errors: string[] = [];
	let done = 0;
	for (const c of children) {
		try {
			await deps.client.request("PATCH", `/pages/${c.id}`, {
				in_trash: true,
			});
		} catch (err) {
			errors.push(
				`${c.title || c.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		onProgress?.(++done, children.length);
	}
	if (errors.length > 0) {
		throw new Error(
			`failed to trash ${errors.length} page(s): ${errors.join("; ")}`,
		);
	}
	return children.length;
}
