// Orchestrator: one sync round = local snapshot → remote snapshot
// (journal/search/round-robin/audit) → plan → apply → journal write →
// cursor/state bookkeeping. Concurrent requests coalesce into at most one
// follow-up round.

import { basename } from "../sync/vault-io";
import { childDirOf } from "../sync/paths";
import type { SyncDeps, SyncReport } from "../sync/deps";
import { newReport } from "../sync/deps";
import type { SyncEntry, SyncState } from "../sync/state";
import { makeLinks } from "../sync/push";
import { plan } from "./plan";
import type { BaseNode, ParentRef } from "./types";
import { snapshotLocal } from "./local";
import { snapshotRemote } from "./remote";
import { applyActions, type ApplyCtx } from "./apply";
import { writeJournal } from "./journal";
import type { BaseStore } from "./base-store";
import { syncConfig } from "../config/sync";
import { anyConfigEnabled, type ConfigSyncSettings } from "../config/filter";
import type { ConfigIO } from "../config/config-io";

export interface EngineSettings {
	fullAuditHours: number;
	roundRobinPerRound: number;
	/** files larger than this are skipped and reported as blocked. */
	maxFileSizeMB?: number;
	/** prompt before this many local deletions in one round (0 = off). */
	deleteGuardThreshold?: number;
}

export interface EngineDeps extends SyncDeps {
	baseStore: BaseStore;
	engine: EngineSettings;
	/** bulk local-delete confirmation; absent → delete as planned. */
	confirmLocalDeletes?: (
		paths: string[],
	) => Promise<"delete" | "keep" | "cancel">;
	/** M5: config-dir sync (absent → skipped entirely). */
	configIO?: ConfigIO;
	configSync?: ConfigSyncSettings;
	/** manifest.id — own plugin dir never syncs. */
	selfId?: string;
	isMobile?: boolean;
}

const hex = (id: string): string => id.replace(/-/g, "").toLowerCase();

export async function runSync(
	deps: EngineDeps,
	opts: { full: boolean },
): Promise<SyncReport> {
	const report = newReport();
	const state = deps.state;
	const now = deps.now?.() ?? Date.now();
	// snapshots mutate state — snapshot it up front so "cancel" can restore
	const before = JSON.parse(JSON.stringify(state)) as SyncState;

	// Apply runs actions in parallel now — serialize saveState calls and
	// coalesce a second request arriving while one write is in flight.
	const rawSave = deps.saveState;
	let saving = false;
	let dirtyAgain = false;
	deps = {
		...deps,
		saveState: async () => {
			if (saving) {
				dirtyAgain = true;
				return;
			}
			saving = true;
			try {
				do {
					dirtyAgain = false;
					await rawSave();
				} while (dirtyAgain);
			} finally {
				saving = false;
			}
		},
	};

	// 1. local snapshot — remember how many rename hints existed now so a
	// hint recorded *during* the round survives to the next one.
	const hintCount = state.renameHints?.length ?? 0;
	deps.event?.({ t: "phase", phase: "scanLocal" });
	const localSnap = await snapshotLocal(deps.vault, state, (d, t, p) =>
		deps.event?.({
			t: "scan",
			stage: "local",
			done: d,
			total: t,
			label: p,
		}),
	);

	// 2+3. remote snapshot (journal read inside)
	const links = makeLinks(deps);
	deps.event?.({ t: "phase", phase: "scanRemote" });
	const remoteSnap = await snapshotRemote(deps, {
		full: opts.full,
		roundRobinPerRound: deps.engine.roundRobinPerRound,
		fullAuditHours: deps.engine.fullAuditHours,
		links,
		now,
	});
	if (remoteSnap.journalSeen.length > 0 || (state.journalSeen ?? []).length === 0) {
		state.journalSeen = remoteSnap.journalSeen;
	}

	// 4. plan
	const base: Record<string, BaseNode> = {};
	for (const [id, e] of Object.entries(state.entries)) {
		base[id] = {
			id,
			kind: e.kind === "note" || e.kind === "file" ? e.kind : "folder",
			parentId:
				hex(e.parentId) === hex(state.rootPageId)
					? "root"
					: hex(e.parentId),
			name: basename(e.path),
			sha: e.srcSha ?? e.localHash ?? e.fileSha ?? null,
		};
	}
	const remoteAddedById = new Map(
		remoteSnap.remoteAdded.map((a) => [a.id, a]),
	);
	const dirOf = (parent: ParentRef): string => {
		if ("newLocal" in parent) return parent.newLocal;
		const hid = "id" in parent ? hex(parent.id) : hex(parent.newRemote);
		if (hid === "root") return "";
		const added = remoteAddedById.get(hid);
		if (added) {
			const d = dirOf(added.parent);
			return childDirOf(d ? `${d}/${added.name}` : added.name, added.kind);
		}
		const e = state.entries[hid];
		if (!e) return "";
		const p = localSnap.pathOf.get(hid) ?? e.path;
		// same helper the applier uses — the two phases must agree on a
		// child's directory (a note's children live in a sibling folder)
		return childDirOf(p, e.kind === "folder" ? "folder" : "note");
	};
	const planActions = (keepLocal?: Set<string>) =>
		plan({
			base,
			local: localSnap.local,
			remote: remoteSnap.remote,
			localAdded: localSnap.localAdded,
			remoteAdded: remoteSnap.remoteAdded,
			pathOf: (parent, name) => {
				const d = dirOf(parent);
				return d ? `${d}/${name}` : name;
			},
			keepLocal,
		});
	let actions = planActions();

	// 4b. bulk local-delete guard: many remote deletions about to trash
	// local files → confirm first (keep → re-upload instead).
	const trashIds = actions
		.filter(
			(a) =>
				a.type === "trashLocal" &&
				state.entries[a.id]?.kind !== "folder",
		)
		.map((a) => (a as { id: string }).id);
	const threshold = deps.engine.deleteGuardThreshold ?? 0;
	if (
		threshold > 0 &&
		trashIds.length >= threshold &&
		deps.confirmLocalDeletes
	) {
		const paths = trashIds.map(
			(id) => state.entries[id]?.path ?? id,
		);
		const choice = await deps.confirmLocalDeletes(paths);
		if (choice === "cancel") {
			for (const k of Object.keys(state)) {
				delete (state as unknown as Record<string, unknown>)[k];
			}
			Object.assign(state, before);
			report.warnings.push(
				`sync cancelled: ${trashIds.length} local deletions not confirmed`,
			);
			return report;
		}
		if (choice === "keep") {
			actions = planActions(new Set(trashIds));
		}
	}
	deps.event?.({
		t: "phase",
		phase: "plan",
		count: actions.filter(
			(a) => a.type !== "link" && a.type !== "forget",
		).length,
	});

	// 5. apply
	for (const n of remoteSnap.nestedUnderPage ?? []) {
		report.warnings.push(
			`note 「${n.title}」 has ${n.count} child page(s) in Notion — they sync into folder 「${n.title}/」`,
		);
	}
	const ctx: ApplyCtx = {
		deps,
		report,
		localSnap,
		remoteSnap,
		baseStore: deps.baseStore,
		journalOps: [],
		newRemoteFolders: new Map(),
		recreated: new Map(),
	};
	await applyActions(actions, ctx);

	// 5b. config-dir sync (after main apply, before journal write)
	if (
		deps.configIO &&
		deps.configSync &&
		anyConfigEnabled(deps.configSync)
	) {
		deps.event?.({ t: "phase", phase: "config" });
		try {
			const cfgRes = await syncConfig(
				{
					client: deps.client,
					state,
					io: deps.configIO,
					settings: deps.configSync,
					selfId: deps.selfId ?? "",
					deviceId: deps.deviceId,
					isMobile: deps.isMobile ?? false,
					now: () => deps.now?.() ?? Date.now(),
					log: deps.log,
				},
				{
					full: opts.full || remoteSnap.auditDue,
					journalCandidateIds: new Set(
						remoteSnap.journalCandidateIds,
					),
				},
			);
			ctx.journalOps.push(...cfgRes.journalOps);
			report.conflictCopies.push(...cfgRes.conflictCopies);
			if (cfgRes.localWritten) report.configWritten = true;
		} catch (err) {
			report.warnings.push(`config sync failed: ${String(err)}`);
		}
	}

	// 6. journal write when remote changed
	if (ctx.journalOps.length > 0) {
		deps.event?.({ t: "phase", phase: "journal" });
		try {
			await writeJournal(deps, ctx.journalOps);
		} catch (err) {
			report.warnings.push(`journal write failed: ${String(err)}`);
		}
	}

	// 7. bookkeeping
	if (remoteSnap.auditDue) state.lastFullAudit = now;
	state.renameHints = (state.renameHints ?? []).slice(hintCount);
	state.lastSyncAt = now;
	state.lastReport = {
		created: report.created,
		updated: report.updated,
		skipped: report.skipped,
		failed: report.failed,
		failures: report.failures.slice(0, 20),
		warnings: report.warnings.slice(0, 20),
		conflictCopies: report.conflictCopies.slice(0, 20),
	};
	await deps.saveState();
	return report;
}

/** Coalescing wrapper: one round at a time; requests during a round fold
 * into a single follow-up round (full wins over incremental). Deps are
 * fetched lazily per round so settings/token changes apply immediately. */
export class SyncRunner {
	private running = false;
	private pending: { full: boolean } | null = null;
	private lastReport: SyncReport | null = null;

	constructor(
		private readonly getDeps: () => Promise<EngineDeps | null>,
		private readonly onReport?: (r: SyncReport, full: boolean) => void,
		private readonly runRound: (
			deps: EngineDeps,
			opts: { full: boolean },
		) => Promise<SyncReport> = runSync,
	) {}

	async request(full = false): Promise<SyncReport> {
		if (this.running) {
			this.pending = {
				full: full || (this.pending?.full ?? false),
			};
			// waiters get the follow-up round's report
			while (this.running) {
				await new Promise((r) => setTimeout(r, 20));
			}
			return this.lastReport ?? newReport();
		}
		let wantFull = full;
		do {
			this.pending = null;
			this.running = true;
			try {
				const deps = await this.getDeps();
				if (deps) {
					this.lastReport = await this.runRound(deps, {
						full: wantFull,
					});
					this.onReport?.(this.lastReport, wantFull);
				}
			} finally {
				this.running = false;
			}
			const pend = this.pending as { full: boolean } | null;
			wantFull = pend?.full ?? false;
		} while (this.pending !== null);
		return this.lastReport ?? newReport();
	}
}
