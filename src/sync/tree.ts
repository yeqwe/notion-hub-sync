import type { NotionClient } from "../notion/client";
import type { SyncState } from "./state";

export interface TreeNode {
	pageId: string;
	title: string;
	hasChildren: boolean;
	children: TreeNode[];
}

/** All child_page blocks of a page (paginated, in_trash skipped). */
export async function listChildPages(
	client: NotionClient,
	pageId: string,
): Promise<
	Array<{
		id: string;
		title: string;
		hasChildren: boolean;
		lastEdited?: string;
	}>
> {
	const out: Array<{
		id: string;
		title: string;
		hasChildren: boolean;
		lastEdited?: string;
	}> = [];
	let cursor: string | undefined;
	do {
		const path = `/blocks/${pageId}/children?page_size=100${
			cursor ? `&start_cursor=${cursor}` : ""
		}`;
		const res = await client.request<{
			results?: Array<{
				id: string;
				type: string;
				in_trash?: boolean;
				has_children?: boolean;
				child_page?: { title?: string };
				last_edited_time?: string;
			}>;
			next_cursor?: string | null;
		}>("GET", path);
		for (const b of res.results ?? []) {
			if (b.type === "child_page" && !b.in_trash) {
				out.push({
					id: b.id,
					title: b.child_page?.title ?? "",
					hasChildren: b.has_children ?? false,
					lastEdited: b.last_edited_time,
				});
			}
		}
		cursor = res.next_cursor ?? undefined;
	} while (cursor);
	return out;
}

type PageKind = "folder" | "note" | "file" | "config" | "history" | "journal";

/** Kind from the page's icon (state entry wins when present). */
export async function classifyPage(
	client: NotionClient,
	state: SyncState,
	pageId: string,
): Promise<PageKind> {
	const hex = pageId.replace(/-/g, "").toLowerCase();
	if (hex === state.historyRootId) return "history";
	if (hex === state.journalId) return "journal";
	const known = state.entries[hex];
	if (known) return known.kind;
	const page = await client.request<{ icon?: { type?: string; emoji?: string } | null }>(
		"GET",
		`/pages/${pageId}`,
	);
	const emoji = page.icon?.emoji;
	if (emoji === "📁") return "folder";
	if (emoji === "📎") return "file";
	if (emoji === "⚙️") return "config";
	if (emoji === "🗄️") return "history";
	if (emoji === "🧾") return "journal";
	return "note";
}
