// Pure per-path config planner: 3-way per file (base sha vs local sha vs
// remote sha). Config files are binary — no merge: conflicts → remote
// wins, local bytes preserved as a local-only conflict copy.

export interface ConfigBase {
	pageId: string;
	sha: string;
	mediaBlockId?: string;
	localMtime?: number;
	localSize?: number;
}

export type ConfigSide =
	| { exists: false }
	| { exists: true; sha: string };

export type ConfigAction =
	| { type: "pushCreate"; rel: string }
	| { type: "pushUpdate"; rel: string; pageId: string }
	| { type: "pullWrite"; rel: string; pageId: string }
	| { type: "conflictWrite"; rel: string; pageId: string } // remote wins + local copy
	| { type: "trashRemote"; rel: string; pageId: string }
	| { type: "trashLocal"; rel: string }
	| { type: "updateBase"; rel: string }
	| { type: "dropBase"; rel: string };

export function planConfig(
	base: Record<string, ConfigBase>,
	local: Record<string, ConfigSide>,
	remote: Record<string, { sha: string; pageId: string } | { deleted: true }>,
): ConfigAction[] {
	const out: ConfigAction[] = [];
	const paths = new Set([
		...Object.keys(base),
		...Object.keys(local),
		...Object.keys(remote),
	]);
	for (const rel of [...paths].sort()) {
		const b = base[rel];
		const l = local[rel];
		const r = remote[rel];
		const lexists = l?.exists === true;
		// ABSENT from the remote map = not evaluated this round = unchanged,
		// not deleted (deletion is an explicit {deleted} marker)
		const rexists =
			r === undefined ? b !== undefined : !("deleted" in r);
		const rsha =
			r === undefined
				? (b?.sha ?? null)
				: "deleted" in r
					? null
					: r.sha;
		const lc = lexists && (!b || l.sha !== b.sha);
		const rc = rexists && (!b || rsha !== b.sha);

		if (!lexists && !rexists) {
			if (b) out.push({ type: "dropBase", rel });
			continue;
		}
		if (!b) {
			// bootstrap: no base entry
			if (lexists && rexists) {
				if (l.sha === rsha) {
					out.push({ type: "updateBase", rel });
				} else {
					out.push({
						type: "conflictWrite",
						rel,
						pageId: (r as { pageId: string }).pageId,
					});
				}
			} else if (lexists) {
				out.push({ type: "pushCreate", rel });
			} else if (rexists) {
				out.push({
					type: "pullWrite",
					rel,
					pageId: (r as { pageId: string }).pageId,
				});
			}
			continue;
		}
		if (!lexists) {
			// deleted locally
			if (rc) {
				out.push({ type: "pullWrite", rel, pageId: b.pageId }); // modification wins
			} else {
				out.push({ type: "trashRemote", rel, pageId: b.pageId });
			}
			continue;
		}
		if (!rexists) {
			if (lc) {
				out.push({ type: "pushCreate", rel }); // recreate, fresh identity
			} else {
				out.push({ type: "trashLocal", rel });
			}
			continue;
		}
		const pageId =
			r !== undefined && !("deleted" in r) ? r.pageId : b.pageId;
		if (lc && rc) {
			if (l.sha === rsha) {
				out.push({ type: "updateBase", rel });
			} else {
				out.push({ type: "conflictWrite", rel, pageId });
			}
		} else if (lc) {
			out.push({ type: "pushUpdate", rel, pageId });
		} else if (rc) {
			out.push({ type: "pullWrite", rel, pageId });
		} else {
			out.push({ type: "updateBase", rel });
		}
	}
	return out;
}
