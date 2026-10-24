import type {
	Action,
	BaseNode,
	LocalAdded,
	ParentRef,
	PlanInput,
	RemoteAdded,
	Side,
} from "./types";

const ROOT = "root";

function parentKey(parent: ParentRef): string {
	if ("id" in parent) return `id:${parent.id}`;
	if ("newLocal" in parent) return `newLocal:${parent.newLocal}`;
	return `newRemote:${parent.newRemote}`;
}

function sameParent(a: ParentRef, b: ParentRef): boolean {
	return parentKey(a) === parentKey(b);
}

/** Groups of base entries that all claim ONE place. Only the first survives;
 * the rest are dropped from the plan entirely (`returned` as ids to retire),
 * so the main decision loop never sees them — letting it run would produce
 * `trashLocal` for a directory another entry still needs.
 *
 * The survivor is the entry whose remote page still exists (trashing it and
 * keeping a dead one forces a re-create, and a re-created page gets a new id
 * the other device never learns — that is the recreate/trash ping-pong).
 * Among equals the lowest page id wins, because hex32 compares identically
 * on every device and they must all agree. */
function duplicateAt(
	base: Record<string, BaseNode>,
	local: Record<string, Side>,
	remote: Record<string, Side>,
	skip?: Set<string>,
): { dead: string[]; alive: string[] } {
	const dead: string[] = [];
	const alive: string[] = [];
	const groups = new Map<string, string[]>();
	for (const [id, b] of Object.entries(base)) {
		if (skip?.has(id)) continue;
		const le = local[id];
		if (!le || le.deleted) continue;
		const key = `${b.kind}\u0000${parentKey(le.parent)}\u0000${le.name}`;
		const ids = groups.get(key);
		if (ids) ids.push(id);
		else groups.set(key, [id]);
	}
	for (const ids of groups.values()) {
		if (ids.length < 2) continue;
		const winner = [...ids].sort((a, b) => {
			const aDead = remote[a]?.deleted === true ? 1 : 0;
			const bDead = remote[b]?.deleted === true ? 1 : 0;
			return aDead - bDead || (a < b ? -1 : a > b ? 1 : 0);
		})[0]!;
		for (const id of ids) {
			if (id === winner) continue;
			if (remote[id]?.deleted === true) dead.push(id);
			else alive.push(id);
		}
	}
	return { dead, alive };
}

interface Eval {
	changed: boolean; // content changed vs base
	moved: boolean; // location changed vs base
	deleted: boolean;
	side: Extract<Side, { deleted: false }> | null;
}

function evalSide(side: Side | undefined, base: BaseNode): Eval {
	if (side === undefined) {
		return { changed: false, moved: false, deleted: false, side: null };
	}
	if (side.deleted) {
		return { changed: false, moved: false, deleted: true, side: null };
	}
	const changed = side.sha !== base.sha;
	const moved =
		!("id" in side.parent) ||
		side.parent.id !== base.parentId ||
		side.name !== base.name;
	return { changed, moved, deleted: false, side };
}

/** Depth of a base node by walking parentId chains (cycles → 0). */
function makeDepth(base: Record<string, BaseNode>): (id: string) => number {
	const memo = new Map<string, number>();
	const depth = (id: string, seen: Set<string>): number => {
		const cached = memo.get(id);
		if (cached !== undefined) return cached;
		if (seen.has(id)) return 0;
		seen.add(id);
		const node = base[id];
		let d = 0;
		if (node && node.parentId !== ROOT && base[node.parentId]) {
			d = 1 + depth(node.parentId, seen);
		}
		memo.set(id, d);
		return d;
	};
	return (id) => depth(id, new Set());
}

/**
 * Where a base node ends up after the plan (its final parent key + whether
 * it survives). Used only for the folder-deletion guard.
 */
function finalPlacement(
	id: string,
	base: BaseNode,
	le: Eval,
	re: Eval,
): { alive: boolean; parentKey: string | null } {
	if (le.deleted && re.deleted) return { alive: false, parentKey: null };
	if (le.deleted) {
		if (re.changed) {
			// restoreLocal: survives at the REMOTE location
			const pk = re.moved
				? parentKey(re.side!.parent)
				: `id:${base.parentId}`;
			return { alive: true, parentKey: pk };
		}
		return { alive: false, parentKey: null };
	}
	if (re.deleted) {
		if (le.changed) {
			// recreateRemote: survives at the LOCAL location
			const pk = le.moved
				? parentKey(le.side!.parent)
				: `id:${base.parentId}`;
			return { alive: true, parentKey: pk };
		}
		return { alive: false, parentKey: null };
	}
	// both alive: remote wins on dual moves
	const pk = re.moved
		? parentKey(re.side!.parent)
		: le.moved
			? parentKey(le.side!.parent)
			: `id:${base.parentId}`;
	return { alive: true, parentKey: pk };
}

export function plan(input: PlanInput): Action[] {
	const { base, local, remote, pathOf } = input;
	// Out-of-scope entries and any added item that belongs to them are dropped
	// before any rule runs, so no rule can emit an action for a path this
	// device does not sync.
	const skip = input.skipIds ?? new Set<string>();
	const localAdded = input.localAdded.filter((a) => !skip.has(a.path));
	// Remote additions have no id this device knows, so scope is tested on
	// their reconstructed path instead (with the item's own shape: a folder
	// has no extension and would otherwise read as "other").
	const remoteAdded = input.skipPath
		? input.remoteAdded.filter(
				(r) =>
					!input.skipPath!(
						pathOf(r.parent, r.name),
						r.kind === "folder",
					),
			)
		: input.remoteAdded;
	const evals = new Map<string, { le: Eval; re: Eval }>();
	for (const [id, b] of Object.entries(base)) {
		if (skip.has(id)) continue;
		const le = evalSide(local[id], b);
		const re = evalSide(remote[id], b);
		// kept-by-user ids count as locally changed → recreated remotely
		if (re.deleted && input.keepLocal?.has(id)) le.changed = true;
		evals.set(id, { le, re });
	}

	// ----- added-item matching by full path -----
	const remoteByPath = new Map<string, RemoteAdded>();
	for (const r of remoteAdded) {
		remoteByPath.set(pathOf(r.parent, r.name), r);
	}
	const matchedRemote = new Set<string>();
	const addedActions: Action[] = [];
	// matched remoteAdded pages with no content → push local onto them
	const earlyContents: Action[] = [];

	// Every place a base entry speaks for, and which entry that is. A
	// remote-added page landing on one of them is not a new item, it is the
	// SAME place seen twice — either two devices each created a page for one
	// new folder (a folder has no content, so no sha can tell them apart) or
	// an old duplicate page is still around.
	//
	// Entries deleted LOCALLY still count: their place is what the user just
	// removed, so pulling a page back onto it would resurrect the folder.
	const takenByBase = new Map<string, string>();
	for (const [id, b] of Object.entries(base)) {
		if (skip.has(id)) continue;
		const le = local[id];
		if (le === undefined) continue; // not evaluated this round
		const key = le.deleted
			? `${parentKey({ id: b.parentId })}\u0000${b.name}`
			: `${parentKey(le.parent)}\u0000${le.name}`;
		takenByBase.set(key, id);
	}
	for (const l of localAdded) {
		const remote = remoteByPath.get(l.path) ?? null;
		if (remote) {
			matchedRemote.add(remote.id);
			if (l.kind === "folder" || l.sha === remote.sha) {
				addedActions.push({
					type: "link",
					id: remote.id,
					localPath: l.path,
					kind: l.kind,
				});
			} else if (remote.sha === null) {
				// remote page exists but has no content (e.g. a push died
				// between page create and content attach) — local wins.
				addedActions.push({
					type: "link",
					id: remote.id,
					localPath: l.path,
					kind: l.kind,
				});
				earlyContents.push({ type: "pushContent", id: remote.id });
			} else {
				addedActions.push(
					{
						type: "localConflictCopy",
						localPath: l.path,
						conflictsWith: remote.id,
					},
					{
						type: "pullNew",
						id: remote.id,
						kind: remote.kind,
						parent: remote.parent,
						name: remote.name,
					},
				);
			}
			continue;
		}
		if (l.kind === "folder") {
			addedActions.push({
				type: "createRemoteFolder",
				localPath: l.path,
				parent: l.parent,
			});
		} else {
			addedActions.push({
				type: "pushNew",
				localPath: l.path,
				kind: l.kind,
				parent: l.parent,
			});
		}
	}
	// A remote-added page on a place a base entry already speaks for is the
	// same thing seen twice, not a new item. Two cases:
	//
	//  • the base entry is still there → two devices each created a page for
	//    one new folder (a folder has no content, so no sha tells them
	//    apart). The lowest page id wins: hex32 compares identically
	//    everywhere and both devices can see both ids, so they agree.
	//  • the base entry was deleted LOCALLY → the user removed this place.
	//    If the remote entry is STILL ALIVE it is a leftover duplicate and
	//    must go (otherwise pulling it back resurrects the deleted folder).
	//    If the remote entry is gone too, this page was created by ANOTHER
	//    device that re-created the item — deleting it would make that
	//    device rebuild it, and the two never converge.
	//
	// Neither case may fall through to createLocalFolder/pullNew.
	const duplicatePages: string[] = [];
	for (const r of remoteAdded) {
		if (matchedRemote.has(r.id)) continue;
		const key = `${parentKey(r.parent)}\u0000${r.name}`;
		const baseId = takenByBase.get(key);
		if (baseId !== undefined) {
			const le = local[baseId]!;
			if (le.deleted) {
				// the remote entry this device knew is being trashed this round
				const stillRemote = remote[baseId]?.deleted !== true;
				if (stillRemote) {
					// leftover duplicate of a place the user just deleted
					duplicatePages.push(r.id);
					continue;
				}
				// The remote copy is gone as well: this page is the re-creation
				// another device performed (it edited the item while this one
				// deleted it). Both sides must agree on the outcome, and the
				// page already exists, so ADOPT it. Trashing it here would make
				// the other device rebuild it next round and the pair would
				// never converge.
				//
				// The place comes from the base entry: the local copy is gone,
				// so its old path is the only description of where the item
				// used to live.
				const baseNode = base[baseId]!;
				addedActions.push({
					type: "link",
					id: r.id,
					localPath: pathOf(
						{ id: baseNode.parentId },
						baseNode.name,
					),
					kind: baseNode.kind,
				});
				continue;
			}
			if (baseId < r.id) {
				// keep the entry this device already has — unless its remote copy
				// is known to be gone, or was not evaluated at all. A page at
				// this place that the base has no live id for means the base id
				// names a page that is no longer there: the newcomer IS the
				// replacement, so adopt it. Deleting it instead would make the
				// other device re-create it, under yet another id.
				const baseAlive = remote[baseId]?.deleted === false;
				if (!baseAlive) {
					addedActions.push({
						type: "link",
						id: r.id,
						localPath: pathOf(le.parent, le.name),
						kind: base[baseId]!.kind,
					});
					duplicatePages.push(baseId);
					continue;
				}
				duplicatePages.push(r.id);
			} else {
				// the remote page wins: bind the local path to it, and retire
				// the base entry (trashRemote removes it). link runs before
				// every trash, so the place is never left unclaimed.
				addedActions.push({
					type: "link",
					id: r.id,
					localPath: pathOf(le.parent, le.name),
					kind: base[baseId]!.kind,
				});
				duplicatePages.push(baseId);
			}
			continue;
		}
		if (r.kind === "folder") {
			addedActions.push({
				type: "createLocalFolder",
				id: r.id,
				parent: r.parent,
				name: r.name,
			});
		} else {
			addedActions.push({
				type: "pullNew",
				id: r.id,
				kind: r.kind,
				parent: r.parent,
				name: r.name,
			});
		}
	}

	// ----- folder survival check (for the deletion guard) -----
	const folderNeeded = new Set<string>();
	for (const [id, b] of Object.entries(base)) {
		if (b.kind !== "folder" || skip.has(id)) continue;
		const { le, re } = evals.get(id)!;
		const wantsDelete = le.deleted !== re.deleted;
		if (!wantsDelete) continue;
		folderNeeded.add(id);
	}
	const stillNeeded = new Set<string>();
	if (folderNeeded.size > 0) {
		for (const [id, b] of Object.entries(base)) {
			if (skip.has(id)) continue;
			const { le, re } = evals.get(id)!;
			const fp = finalPlacement(id, b, le, re);
			if (fp.alive && fp.parentKey) {
				stillNeeded.add(fp.parentKey);
			}
		}
		for (const a of localAdded) stillNeeded.add(parentKey(a.parent));
		for (const a of remoteAdded) stillNeeded.add(parentKey(a.parent));
	}

	// ----- duplicate entries (two ids, one place) -----
	// Decided BEFORE the per-id loop so a duplicate never reaches it: letting
	// the loop see one would produce trashLocal for a directory the surviving
	// entry still needs.
	const dups = duplicateAt(base, local, remote, skip);
	// a dead duplicate's page is gone: drop the entry. An alive one is a real
	// second page → trash it (its twin keeps the place).
	const dupForgets: Action[] = dups.dead.map((id) => ({ type: "forget", id }));
	const dupTrashes = dups.alive.map((id) => ({ type: "trashRemote" as const, id }));

	// ----- per-id decision -----
	const moves: Action[] = [];
	const contents: Action[] = [];
	const trashes: Array<{ action: Action; depth: number }> = [];
	const forgets: Action[] = [];
	const folderRecreates: Extract<Action, { type: "recreateRemote" }>[] =
		[];

	// Remote pages that may be adopted by a `recreateRemote`: the place is
	// spoken for by a base entry whose REMOTE copy is gone (that is why the
	// item is being re-created). Such a page is the re-creation another device
	// already performed — its id never reached this base, so it arrives as
	// `remoteAdded`. Adopting it makes both devices converge on one id;
	// minting a second page would leave them deleting each other's forever.
	//
	// Entries still alive remotely are NOT adoptable: their place is taken and
	// `duplicatePages` decides those.
	const adoptable = new Map<string, string>();
	for (const [id, b] of Object.entries(base)) {
		const le = local[id];
		if (!le || le.deleted) continue;
		if (remote[id]?.deleted !== true) continue;
		const key = `${parentKey(le.parent)}\u0000${b.name}`;
		// the placeholder marks "this place wants a page"; the actual id is
		// filled in from remoteAdded below
		adoptable.set(key, "");
	}
	for (const r of remoteAdded) {
		if (matchedRemote.has(r.id) || duplicatePages.includes(r.id)) continue;
		const key = `${parentKey(r.parent)}\u0000${r.name}`;
		if (!adoptable.has(key)) continue;
		if (adoptable.get(key) === "") adoptable.set(key, r.id);
	}
	const depthOf = makeDepth(base);

	for (const [id, b] of Object.entries(base)) {
		if (skip.has(id)) continue;
		const { le, re } = evals.get(id)!;
		const isFolder = b.kind === "folder";

		if (dups.dead.includes(id) || dups.alive.includes(id)) continue;

		if (le.deleted && re.deleted) {
			forgets.push({ type: "forget", id });
			continue;
		}
		if (le.deleted) {
			// The local file is gone. Before deleting anything remotely, prove
			// that its disappearance is explained (RS's `prevSync == current`
			// check): the file was there last round, unchanged, and is gone
			// now. An unexplained disappearance is a listing that missed it or
			// a failed write — deleting the remote copy would destroy the only
			// remaining one.
			if (!(input.isDeletionExplained?.(id) ?? true)) {
				continue; // no action: leave both sides alone this round
			}
			if (re.changed) {
				contents.push({ type: "restoreLocal", id });
			} else if (isFolder && stillNeeded.has(`id:${id}`)) {
				// folder still needed by survivors — retry next round
			} else {
				trashes.push({
					action: { type: "trashRemote", id },
					depth: depthOf(id),
				});
			}
			continue;
		}
		if (re.deleted) {
			// A page at the same place that nobody claims is this item's
			// re-creation by another device — reuse it instead of minting yet
			// another id that the other device would delete as a duplicate.
			const adopt =
				le.side === null
					? undefined
					: adoptable.get(
							`${parentKey(le.side.parent)}\u0000${b.name}`,
						) || undefined;
			if (
				isFolder &&
				(le.changed || stillNeeded.has(`id:${id}`))
			) {
				// still needed locally → recreate the page (children that
				// resolve their parent by id get remapped at apply time)
				folderRecreates.push({
					type: "recreateRemote",
					id,
					...(adopt === undefined ? {} : { adopt }),
				});
			} else if (le.changed) {
				contents.push({
					type: "recreateRemote",
					id,
					...(adopt === undefined ? {} : { adopt }),
				});
			} else {
				trashes.push({
					action: { type: "trashLocal", id },
					depth: depthOf(id),
				});
			}
			continue;
		}

		// both alive — content first, then location
		if (!isFolder) {
			const lsha = le.side === null ? null : le.side.sha;
			// The local bytes are an OLD version this entry has already moved
			// past. That is a rollback, not an edit: pushing it would overwrite
			// a NEWER remote with an older one — the "phone woke up and undid
			// my day's work" report. Whatever the remote holds is the truth;
			// pulling it also restores the file that was rolled back.
			const stale =
				le.changed &&
				lsha !== null &&
				(input.staleShas?.(id)?.includes(lsha) ?? false);
			if (stale) {
				// remote not evaluated this round → it still holds the base
				const remoteSha = re.side === null ? base.sha : re.side.sha;
				if (remoteSha !== lsha) {
					contents.push({ type: "pullContent", id, stale: true });
				}
			} else if (le.changed && re.changed && le.side!.sha !== re.side!.sha) {
				contents.push(
					b.kind === "note"
						? { type: "merge", id }
						: { type: "conflictCopy", id },
				);
			} else if (le.changed && !re.changed) {
				contents.push({ type: "pushContent", id });
			} else if (re.changed && !le.changed) {
				contents.push({ type: "pullContent", id });
			}
			// lc&rc&equal-sha → converged: engine refreshes base silently
		}

		if (le.moved && re.moved) {
			const sameTarget =
				sameParent(le.side!.parent, re.side!.parent) &&
				le.side!.name === re.side!.name;
			if (!sameTarget) {
				moves.push({
					type: "moveLocal",
					id,
					parent: re.side!.parent,
					name: re.side!.name,
				});
			}
		} else if (le.moved) {
			moves.push({
				type: "moveRemote",
				id,
				parent: le.side!.parent,
				name: le.side!.name,
			});
		} else if (re.moved) {
			moves.push({
				type: "moveLocal",
				id,
				parent: re.side!.parent,
				name: re.side!.name,
			});
		}
	}

	// ----- deterministic ordering -----
	const pathDepth = (p: string): number =>
		p === "" ? 0 : p.split("/").length;
	const folderCreates = addedActions
		.filter(
			(a): a is Extract<Action, { type: "createRemoteFolder" | "createLocalFolder" }> =>
				a.type === "createRemoteFolder" ||
				a.type === "createLocalFolder",
		)
		.sort((x, y) => {
			const px =
				x.type === "createRemoteFolder"
					? x.localPath
					: pathOf(x.parent, x.name);
			const py =
				y.type === "createRemoteFolder"
					? y.localPath
					: pathOf(y.parent, y.name);
			return pathDepth(px) - pathDepth(py) || px.localeCompare(py);
		});
	const rest = addedActions.filter(
		(a) =>
			a.type !== "createRemoteFolder" && a.type !== "createLocalFolder",
	);
	for (const a of dupTrashes) {
		trashes.push({ action: a, depth: 0 });
	}
	forgets.push(...dupForgets);
	const queued = new Set(
		trashes
			.map((t) => ("id" in t.action ? t.action.id : null))
			.filter((id): id is string => id !== null),
	);
	for (const id of duplicatePages) {
		if (queued.has(id)) continue;
		queued.add(id);
		trashes.push({ action: { type: "trashRemote", id }, depth: 0 });
	}
	trashes.sort((x, y) => y.depth - x.depth);

	folderRecreates.sort(
		(a, b) => depthOf(a.id) - depthOf(b.id),
	);
	return [
		...folderRecreates,
		...folderCreates,
		...moves,
		...rest,
		...earlyContents,
		...contents,
		...trashes.map((t) => t.action),
		...forgets,
	];
}
