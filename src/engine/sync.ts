// Orchestrator: one sync round = local snapshot → remote snapshot
// (journal/search/round-robin/audit) → plan → apply → journal write →
// cursor/state bookkeeping. Concurrent requests coalesce into at most one
// follow-up round.

import { basename } from "../sync/vault-io";
import { NotionApiError } from "../notion/client";
import { childDirOf } from "../sync/paths";
import type { SyncDeps, SyncReport } from "../sync/deps";
import { newReport } from "../sync/deps";
import type { SyncEntry, SyncState } from "../sync/state";
import { makeLinks } from "../sync/push";
import { makeScope, type Scope, type ScopeSettings } from "../sync/scope";
import type { BlockedPath } from "../sync/blocked";
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
	/** which paths this device syncs at all (absent → everything). */
	scope?: ScopeSettings;
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
	/** Non-null when the persisted state could not be read. A round must
	 * not plan against a fresh state in that case: an empty base against a
	 * full remote tree is a 2000-second whole-vault pull, and the save at
	 * the end of it can be interrupted the same way, which is exactly the
	 * loop that makes a device "never finish syncing". */
	stateProblem?: { kind: string; detail: string; bytes: number } | null;
}

const hex = (id: string): string => id.replace(/-/g, "").toLowerCase();

/** 401/403 = the integration token or the page permission is gone. Every
 * later request would fail identically, so this is a round-stopping
 * condition, not a per-file one. */
function isAuthError(err: unknown): boolean {
	return (
		err instanceof NotionApiError &&
		(err.status === 401 || err.status === 403)
	);
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Log a milestone with an elapsed-time stamp. `log` is the bounded channel
 * (one line per phase); per-item detail goes to `debug`.
 *
 * Quiet-when-idle: an unchanged round produces exactly two lines (start and
 * done). Everything in between is staged and only flushed when the round
 * actually has something to report — a 5-minute interval that logs ten
 * "nothing to do" lines per hour is how a log stops being read. */
function makeTrace(deps: SyncDeps): {
	log: (msg: string) => void;
	debug: (msg: string) => void;
	/** Phase milestone: held until the round is known to be non-empty. */
	phase: (msg: string) => void;
	flushPhases: () => void;
	since: () => string;
} {
	const t0 = Date.now();
	const pending: string[] = [];
	return {
		log: (m) => deps.log?.(`[+${Date.now() - t0}ms] ${m}`),
		debug: (m) => deps.debug?.(`[+${Date.now() - t0}ms] ${m}`),
		phase: (m) => pending.push(`[+${Date.now() - t0}ms] ${m}`),
		flushPhases: () => {
			for (const m of pending) deps.log?.(m);
			pending.length = 0;
		},
		since: () => `${Date.now() - t0}ms`,
	};
}

export async function runSync(
	deps: EngineDeps,
	opts: { full: boolean; forceAudit?: boolean },
): Promise<SyncReport> {
	const report = newReport();
	const state = deps.state;
	const now = deps.now?.() ?? Date.now();
	const tr = makeTrace(deps);
	tr.log(
		`round start: full=${opts.full} entries=${Object.keys(state.entries).length} ` +
			`lastFullAudit=${state.lastFullAudit === undefined ? "never" : `${Math.round((now - state.lastFullAudit) / 60_000)}min ago`}`,
	);
	// Refuse to plan against an unreadable base. The alternative is a silent
	// whole-vault re-pull every round; failing loudly once is the cheaper
	// outcome and the caller can quarantine + retry deliberately.
	if (deps.stateProblem && Object.keys(state.entries).length === 0) {
		report.failed++;
		report.failures.push(
			`sync state unreadable (${deps.stateProblem.kind}: ${deps.stateProblem.detail}, ${deps.stateProblem.bytes} bytes) — refused to re-pull the whole vault; the state file was kept for inspection`,
		);
		tr.log(`round aborted: state unreadable (${deps.stateProblem.kind})`);
		return report;
	}
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
	// The one scope instance for this round: scanner, remote evaluator and
	// planner all consult it, so "what is in scope" cannot change halfway.
	const scope: Scope | null = deps.engine.scope
		? makeScope(deps.engine.scope)
		: null;
	if (scope) deps = { ...deps, scope };
	const skipIds = new Set<string>();
	if (scope) {
		for (const [id, e] of Object.entries(state.entries)) {
			if (!scope.allows(e.path, e.kind === "folder")) skipIds.add(id);
		}
	}
	deps.event?.({ t: "phase", phase: "scanLocal" });
	tr.phase(`phase scanLocal: scope=${scope ? "limited" : "all"} skipIds=${skipIds.size}`);
	const localSnap = await snapshotLocal(
		deps.vault,
		state,
		(d, t, p) =>
			deps.event?.({ t: "scan", stage: "local", done: d, total: t, label: p }),
		scope ?? undefined,
		tr.debug,
	);
	report.blocked.push(...localSnap.blocked);
	const ls = localSnap.stats;
	if (ls.hashed > 0 || ls.renames > 0 || localSnap.blocked.length > 0) {
		tr.phase(
			`phase scanLocal done in ${tr.since()}: ` +
				`${ls.listedFiles} file(s) listed, ${ls.hashed} hashed, ${ls.reused} sha reused, ` +
				`${localSnap.localAdded.length} local-only, ${localSnap.blocked.length} blocked`,
		);
	} else {
		tr.debug(
			`phase scanLocal done in ${tr.since()}: all ${ls.reused} file(s) unchanged (mtime+size)`,
		);
	}
	for (const b of localSnap.blocked) {
		tr.debug(`local blocked ${b.path}: ${b.reason}${b.detail ? ` (${b.detail})` : ""}`);
	}

	// 2+3. remote snapshot (journal read inside)
	const links = makeLinks(deps);
	deps.event?.({ t: "phase", phase: "scanRemote" });
	// A state with no entries has no base to plan against, so the remote
	// tree must be enumerated in full — but that is a *scan*, not one
	// content download per page: the audit compares structure only and the
	// content compare then starts from no base (fetch + link). It is the
	// mandatory cost of re-matching by path, not an extra audit.
	const coldStart = Object.keys(state.entries).length === 0;
	tr.phase(
		`phase scanRemote: full=${opts.full} forceAudit=${coldStart || opts.forceAudit === true} roundRobin=${deps.engine.roundRobinPerRound}`,
	);
	let remoteSnap: Awaited<ReturnType<typeof snapshotRemote>>;
	try {
		remoteSnap = await snapshotRemote(deps, {
			full: opts.full,
			forceAudit: coldStart || opts.forceAudit === true,
			roundRobinPerRound: deps.engine.roundRobinPerRound,
			fullAuditHours: deps.engine.fullAuditHours,
			links,
			now,
		});
	} catch (err) {
		// A rejected token surfaces HERE, on the first read of the journal —
		// long before any file action. Letting it escape would reach the
		// user as a bare error string, and the next automatic round would
		// burn its request budget against the same wall five minutes later.
		if (isAuthError(err)) {
			report.authFailed = true;
			report.failed++;
			report.failures.push(errMessage(err));
			report.warnings.push(
				"Notion rejected the integration token (401/403) — automatic sync is paused until it is fixed in settings",
			);
			tr.log("round aborted: Notion rejected the token");
			return report;
		}
		throw err;
	}
	if (remoteSnap.journalSeen.length > 0 || (state.journalSeen ?? []).length === 0) {
		state.journalSeen = remoteSnap.journalSeen;
	}
	tr.phase(
		`phase scanRemote done in ${tr.since()}: auditDue=${remoteSnap.auditDue} ` +
			`evaluated=${Object.keys(remoteSnap.remote).length} remoteAdded=${remoteSnap.remoteAdded.length} ` +
			`journalCandidates=${remoteSnap.journalCandidateIds.length} fetchedBytes=${remoteSnap.fetchedBytes.size}`,
	);

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
			skipIds,
			skipPath: scope
				? (p, isDir) => !scope.allows(p, isDir)
				: undefined,
			// A local file whose bytes are a version this entry already left
			// behind was ROLLED BACK, not edited. Pushing it is the bug that
			// lets a phone that slept through a day of work restore yesterday's
			// note over the desktop's newer one.
			staleShas: (id) => state.entries[id]?.shaHistory,
		});
	let actions = planActions();
	tr.phase(
		`phase plan in ${tr.since()}: ${actions.length} action(s)`,
	);
	// One debug line per planned action — bounded by the plan size and only
	// emitted to the debug channel, never to the user-facing log.
	for (const a of actions) {
		tr.debug(
			`plan ${a.type} ${"id" in a ? a.id : ""} ${"localPath" in a ? a.localPath : ""}`,
		);
	}

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
			tr.log(`round cancelled by delete guard (${trashIds.length} deletions)`);
			return report;
		}
		if (choice === "keep") {
			actions = planActions(new Set(trashIds));
			tr.log(`delete guard: keep ${trashIds.length} local file(s), re-planning as upload`);
		} else {
			tr.log(`delete guard: confirmed deleting ${trashIds.length} local file(s)`);
		}
	}
	deps.event?.({
		t: "phase",
		phase: "plan",
		count: actions.filter(
			(a) => a.type !== "link" && a.type !== "forget",
		).length,
	});

	if (localSnap.massDeletion) {
		report.warnings.push(
			"the local listing looked incomplete (a large share of the vault seemed to vanish) — deletions were skipped this round; run sync again once Obsidian has finished loading",
		);
	}
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
	// Name the phase the round is actually in. "Applying 12 changes" while a
	// 200 MB download runs looks like a hang; the phase tells them apart.
	const pulls = actions.some(
		(a) =>
			a.type === "pullContent" ||
			a.type === "pullNew" ||
			a.type === "merge" ||
			a.type === "conflictCopy",
	);
	const pushes = actions.some(
		(a) => a.type === "pushContent" || a.type === "pushNew",
	);
	if (pulls) deps.event?.({ t: "phase", phase: "download" });
	else if (pushes) deps.event?.({ t: "phase", phase: "upload" });
	else deps.event?.({ t: "phase", phase: "apply" });
	tr.phase(
		`phase apply: ${actions.filter((a) => a.type !== "link" && a.type !== "forget").length} countable ` +
			`of ${actions.length} (${pulls ? "download" : pushes ? "upload" : "apply"})`,
	);
	await applyActions(actions, ctx);
	// A rejected token makes every remaining round a waste of the request
	// budget, and a plain failure count hides the cause. Stop here, keep the
	// base as it was (nothing was recorded as synced), and let the host
	// pause auto-sync and name the problem.
	if (report.authFailed) {
		for (const k of Object.keys(state)) {
			delete (state as unknown as Record<string, unknown>)[k];
		}
		Object.assign(state, before);
		report.warnings.push(
			"Notion rejected the integration token (401/403) — automatic sync is paused until it is fixed in settings",
		);
		tr.log("round aborted: Notion rejected the token");
		return report;
	}
	tr.phase(
		`phase apply done in ${tr.since()}: created=${report.created} updated=${report.updated} ` +
			`skipped=${report.skipped} failed=${report.failed} blocked=${report.blocked.length} ` +
			`journalOps=${ctx.journalOps.length}`,
	);
	for (const f of report.failures) tr.debug(`failure: ${f}`);
	for (const w of report.warnings) tr.debug(`warning: ${w}`);
	// 5b. config-dir sync (after main apply, before journal write)
	if (
		deps.configIO &&
		deps.configSync &&
		anyConfigEnabled(deps.configSync)
	) {
		deps.event?.({ t: "phase", phase: "config" });
		tr.phase(`phase config: start`);
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
					debug: deps.debug,
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
			tr.phase(
				`phase config done in ${tr.since()}: ops=${cfgRes.journalOps.length} ` +
					`conflicts=${cfgRes.conflictCopies.length} localWritten=${cfgRes.localWritten}`,
			);
		} catch (err) {
			report.warnings.push(`config sync failed: ${String(err)}`);
			tr.log(`phase config failed: ${String(err)}`);
		}
	}

	// 6. journal write when remote changed
	if (ctx.journalOps.length > 0) {
		deps.event?.({ t: "phase", phase: "journal" });
		tr.phase(`phase journal: writing ${ctx.journalOps.length} op(s)`);
		try {
			await writeJournal(deps, ctx.journalOps);
			tr.phase(`phase journal done in ${tr.since()}`);
		} catch (err) {
			report.warnings.push(`journal write failed: ${String(err)}`);
			tr.log(`phase journal failed: ${String(err)}`);
		}
	} else {
		tr.debug("phase journal: nothing to write");
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
		blocked: report.blocked.slice(0, 50),
	};
	await deps.saveState();
	// The round had real work → print the staged phase lines now, before the
	// summary, so the log reads in execution order.
	const didWork =
		report.created + report.updated + report.skipped + report.failed > 0 ||
		report.warnings.length > 0 ||
		report.blocked.length > 0;
	if (didWork) tr.flushPhases();
	tr.log(
		`round done in ${tr.since()}: created=${report.created} updated=${report.updated} ` +
			`skipped=${report.skipped} failed=${report.failed} warnings=${report.warnings.length} ` +
			`conflicts=${report.conflictCopies.length} blocked=${report.blocked.length}` +
			(didWork ? "" : " (nothing to do)"),
	);
	return report;
}

/** Coalescing wrapper: one round at a time; requests during a round fold
 * into a single follow-up round (full wins over incremental). Deps are
 * fetched lazily per round so settings/token changes apply immediately. */
export class SyncRunner {
	private running = false;
	private pending: { full: boolean; forceAudit: boolean } | null = null;
	private lastReport: SyncReport | null = null;

	constructor(
		private readonly getDeps: () => Promise<EngineDeps | null>,
		private readonly onReport?: (r: SyncReport, full: boolean) => void,
		private readonly runRound: (
			deps: EngineDeps,
			opts: { full: boolean; forceAudit?: boolean },
		) => Promise<SyncReport> = runSync,
	) {}

	/** `forceAudit` re-enumerates the whole remote tree even when the audit
	 * timer has not expired — used after a directory-level rename/delete,
	 * where an incremental round could read a moved subtree as "deleted". */
	async request(full = false, forceAudit = false): Promise<SyncReport> {
		if (this.running) {
			this.pending = {
				full: full || (this.pending?.full ?? false),
				forceAudit:
					forceAudit || (this.pending?.forceAudit ?? false),
			};
			// waiters get the follow-up round's report
			while (this.running) {
				await new Promise((r) => setTimeout(r, 20));
			}
			return this.lastReport ?? newReport();
		}
		let wantFull = full;
		let wantAudit = forceAudit;
		do {
			this.pending = null;
			this.running = true;
			try {
				const deps = await this.getDeps();
				if (deps) {
					this.lastReport = await this.runRound(deps, {
						full: wantFull,
						forceAudit: wantAudit,
					});
					this.onReport?.(this.lastReport, wantFull);
				}
			} finally {
				this.running = false;
			}
			const pend = this.pending as {
				full: boolean;
				forceAudit: boolean;
			} | null;
			wantFull = pend?.full ?? false;
			wantAudit = pend?.forceAudit ?? false;
		} while (this.pending !== null);
		return this.lastReport ?? newReport();
	}
}
