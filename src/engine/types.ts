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
	| { type: "pullContent"; id: string }
	| { type: "merge"; id: string }
	| { type: "conflictCopy"; id: string }
	| { type: "localConflictCopy"; localPath: string; conflictsWith: string }
	| { type: "moveRemote"; id: string; parent: ParentRef; name: string }
	| { type: "moveLocal"; id: string; parent: ParentRef; name: string }
	| { type: "trashRemote"; id: string }
	| { type: "trashLocal"; id: string }
	/** Re-create a page whose remote copy is gone. `adopt` names an existing
	 * unclaimed page at the same place: reusing it (instead of creating yet
	 * another id) is what lets two devices converge — a freshly created id is
	 * unknown to the other device, which deletes it as a duplicate and makes
	 * this one create another, forever. */
	| { type: "recreateRemote"; id: string; adopt?: string }
	| { type: "restoreLocal"; id: string }
	| { type: "forget"; id: string };
