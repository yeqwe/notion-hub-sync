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
	const { base, local, remote, localAdded, remoteAdded, pathOf } = input;
	const evals = new Map<string, { le: Eval; re: Eval }>();
	for (const [id, b] of Object.entries(base)) {
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
	for (const l of localAdded) {
		const remote = remoteByPath.get(l.path) ?? null;
		if (remote) {
			matchedRemote.add(remote.id);
			if (l.kind === "folder" || l.sha === remote.sha) {
				addedActions.push({
					type: "link",
					id: remote.id,
					localPath: l.path,
				});
			} else if (remote.sha === null) {
				// remote page exists but has no content (e.g. a push died
				// between page create and content attach) — local wins.
				addedActions.push({
					type: "link",
					id: remote.id,
					localPath: l.path,
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
	for (const r of remoteAdded) {
		if (matchedRemote.has(r.id)) continue;
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
		if (b.kind !== "folder") continue;
		const { le, re } = evals.get(id)!;
		const wantsDelete = le.deleted !== re.deleted;
		if (!wantsDelete) continue;
		folderNeeded.add(id);
	}
	const stillNeeded = new Set<string>();
	if (folderNeeded.size > 0) {
		for (const [id, b] of Object.entries(base)) {
			const { le, re } = evals.get(id)!;
			const fp = finalPlacement(id, b, le, re);
			if (fp.alive && fp.parentKey) {
				stillNeeded.add(fp.parentKey);
			}
		}
		for (const a of localAdded) stillNeeded.add(parentKey(a.parent));
		for (const a of remoteAdded) stillNeeded.add(parentKey(a.parent));
	}

	// ----- per-id decision -----
	const moves: Action[] = [];
	const contents: Action[] = [];
	const trashes: Array<{ action: Action; depth: number }> = [];
	const forgets: Action[] = [];
	const folderRecreates: Extract<Action, { type: "recreateRemote" }>[] =
		[];
	const depthOf = makeDepth(base);

	for (const [id, b] of Object.entries(base)) {
		const { le, re } = evals.get(id)!;
		const isFolder = b.kind === "folder";

		if (le.deleted && re.deleted) {
			forgets.push({ type: "forget", id });
			continue;
		}
		if (le.deleted) {
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
			if (
				isFolder &&
				(le.changed || stillNeeded.has(`id:${id}`))
			) {
				// still needed locally → recreate the page (children that
				// resolve their parent by id get remapped at apply time)
				folderRecreates.push({ type: "recreateRemote", id });
			} else if (le.changed) {
				contents.push({ type: "recreateRemote", id });
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
			if (le.changed && re.changed && le.side!.sha !== re.side!.sha) {
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
