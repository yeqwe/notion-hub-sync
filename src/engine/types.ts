// M4 sync engine — pure planning types, no I/O.
// Identity = Notion page id (hex32). SyncState entries are the Base (B).
// Location is (parentId, name) so children of a moved/renamed folder show
// no change. parentId = hex32 of the parent page, or literal "root".

export type Kind = "folder" | "note" | "file";

/** Parent of a moved/added item: an existing page, a local folder not yet
 * in Notion, or a remote page first seen this round. */
export type ParentRef =
	| { id: string }
	| { newLocal: string }
	| { newRemote: string };

export interface BaseNode {
	id: string;
	kind: Kind;
	parentId: string; // hex32 or "root"
	name: string;
	sha: string | null; // null for folders
}

export type Side =
	| { deleted: true }
	| { deleted: false; parent: ParentRef; name: string; sha: string | null };

export interface LocalAdded {
	path: string;
	kind: Kind;
	parent: ParentRef;
	name: string;
	sha: string | null;
}

export interface RemoteAdded {
	id: string;
	kind: Kind;
	parent: ParentRef;
	name: string;
	sha: string | null;
	/** last_edited_time observed at evaluation — seeds entry.remoteEdited. */
	lastEdited?: string;
}

export interface PlanInput {
	base: Record<string, BaseNode>;
	/** only ids whose local state was evaluated; ABSENT = unchanged vs base */
	local: Record<string, Side>;
	/** only ids evaluated this round; ABSENT = unchanged vs base */
	remote: Record<string, Side>;
	localAdded: LocalAdded[];
	remoteAdded: RemoteAdded[];
	/** full path of a parent+name, for matching added items across sides */
	pathOf(parent: ParentRef, name: string): string;
	/** ids the user chose to keep locally despite remote deletion —
	 * evaluated as if the local side changed (→ recreateRemote). */
	keepLocal?: Set<string>;
	/** ids outside this device's sync scope (excluded folder or a switched-
	 * off file type). They get NO action at all — not a push, not a pull and
	 * above all not a trash: "not in scope" is not "deleted", and treating
	 * it as such would wipe the other side. Applied here rather than by each
	 * caller so a path cannot slip through one rule and not another. */
	skipIds?: Set<string>;
	/** Same idea for items whose id this device has never seen (a page
	 * created remotely this round). Their path is the only thing available,
	 * so scope is tested against the full path instead of the id. `isDir`
	 * comes from the item's kind — a folder has no extension and would
	 * otherwise be classified as "other" and dropped. */
	skipPath?: (path: string, isDir: boolean) => boolean;
	/** Shas this entry has already superseded, newest first
	 * (`SyncEntry.shaHistory`). A local file hashing to one of them was not
	 * edited — it was rolled back by something outside Obsidian. Treating
	 * that as a local edit is what makes a phone that slept through a day of
	 * work push the OLD version back up and erase the desktop's newer one. */
	staleShas?: (id: string) => readonly string[] | undefined;
	/** True when the entry's local disappearance is EXPLAINED: the file was
	 * present at the end of the last round with exactly the mtime+size the
	 * base records, and is gone now. Anything else (never seen, recorded
	 * state disagrees, listing looked incomplete) means "we cannot say the
	 * user deleted this" and no deletion is propagated.
	 *
	 * This is the `prevSync == current` check Remotely Save performs before it
	 * will propagate a deletion, and it is what stops a half-loaded mobile
	 * vault index from wiping pages in Notion. */
	isDeletionExplained?: (id: string) => boolean;
}

export type Action =
	/** `kind` is the LOCAL shape of the path (a directory is a folder no
	 * matter what the page's icon says) — `link` records the entry from it
	 * instead of trusting the remote classification. */
	| { type: "link"; id: string; localPath: string; kind?: Kind }
	| { type: "createRemoteFolder"; localPath: string; parent: ParentRef }
	| { type: "createLocalFolder"; id: string; parent: ParentRef; name: string }
	| { type: "pushNew"; localPath: string; kind: Kind; parent: ParentRef }
	| { type: "pullNew"; id: string; kind: Kind; parent: ParentRef; name: string }
	| { type: "pushContent"; id: string }
	| { type: "pullContent"; id: string; /** local copy was an OLD version,
	 * not an edit — reported so the user knows why the file changed back. */
		stale?: true }
	| { type: "merge"; id: string }
	| { type: "conflictCopy"; id: string }
	| { type: "localConflictCopy"; localPath: string; conflictsWith: string }
	| { type: "moveRemote"; id: string; parent: ParentRef; name: string }
	| { type: "moveLocal"; id: string; parent: ParentRef; name: string }
	| {
			type: "trashRemote";
			id: string;
			/** a duplicate of `mergeInto`: its child pages are moved there
			 * before the trash, because trashing a page in Notion takes its
			 * whole subtree with it. */
			mergeInto?: string;
	  }
	| { type: "trashLocal"; id: string }
	/** Re-create a page whose remote copy is gone. `adopt` names an existing
	 * unclaimed page at the same place: reusing it (instead of creating yet
	 * another id) is what lets two devices converge — a freshly created id is
	 * unknown to the other device, which deletes it as a duplicate and makes
	 * this one create another, forever. */
	| { type: "recreateRemote"; id: string; adopt?: string }
	| { type: "restoreLocal"; id: string }
	| { type: "forget"; id: string };
