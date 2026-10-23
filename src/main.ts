import {
	Notice,
	Platform,
	Plugin,
	TFile,
	TFolder,
	type WorkspaceLeaf,
} from "obsidian";
import { testConnection } from "./connection";
import { getStrings, setOverriddenLocale } from "./i18n";
import { NotionClient } from "./notion/client";
import { parseNotionId } from "./notion/ids";
import {
	DEFAULT_SETTINGS,
	mergeSettings,
	ROUND_ROBIN_PER_ROUND,
	type NotionHubSettings,
} from "./settings";
import {
	loadStateChecked,
	makePathResolver,
	ObsidianVaultIO,
	quarantineState,
	saveState,
} from "./sync/obsidian-vault";
import { entryByPath } from "./sync/state";
import type { SyncState } from "./sync/state";
import type { SyncEvent, SyncReport } from "./sync/deps";
import type { EngineDeps } from "./engine/sync";
import { SyncRunner } from "./engine/sync";
import { BaseStore, type TextIO } from "./engine/base-store";
import { ObsidianConfigIO } from "./config/config-io";
import { NotionHubSettingTab } from "./ui/settings-tab";
import { openHistoryModal } from "./ui/history-modal";
import { openDeletedFilesModal } from "./ui/deleted-files-modal";
import { openStatusModal } from "./ui/status-modal";
import { confirmAction } from "./ui/confirm-modal";
import { confirmLocalDeletes } from "./ui/confirm-delete-modal";
import { clearRemote, resetState } from "./engine/reset";
import { SyncLog } from "./sync/sync-log";
import {
	SYNC_PANEL_VIEW,
	SyncPanelView,
	type SyncPanelDeps,
} from "./ui/sync-panel-view";
import { autoSyncIgnoresPath, wireAutoSync } from "./auto-sync";
import { summarizeBlocked } from "./sync/blocked";
import { blockedLabels } from "./i18n";
import { scanPendingChanges, type PendingChange } from "./sync/changes";

export default class NotionHubSyncPlugin extends Plugin {
	settings: NotionHubSettings = { ...DEFAULT_SETTINGS };
	private statusEl: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;
	private state: SyncState | null = null;
	/** Set when the persisted state was unreadable — blocks planning against
	 * an empty base (a whole-vault re-pull per round). */
	private stateProblem: {
		kind: string;
		detail: string;
		bytes: number;
	} | null = null;
	private io: ObsidianVaultIO | null = null;
	private runner: SyncRunner | null = null;
	private syncing = false;
	private readonly syncLog = new SyncLog({
		persist: (entries) =>
			this.app.vault.adapter.write(
				`${this.manifest.dir ?? ""}/sync-log.json`,
				JSON.stringify(entries),
			),
	});
	private nextTrigger: "manual" | "full" | "auto" = "manual";
	private roundStartAt = 0;
	/** Debounced cache for the panel's "pending changes" card. */
	private pendingCache: PendingChange[] = [];
	private pendingTimer: number | null = null;
	private pendingScanning = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.addSettingTab(new NotionHubSettingTab(this));
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("nhs-status-clickable");
		this.statusEl.addEventListener("click", () => void this.openPanel());
		this.registerView(
			SYNC_PANEL_VIEW,
			(leaf) => new SyncPanelView(leaf, this.panelDeps()),
		);
		await this.loadSyncLog();

		const strings = getStrings();
		this.ribbonEl = this.addRibbonIcon("refresh-cw", "Notion Hub Sync", () =>
			this.runEngine(false),
		);
		this.addRibbonIcon("activity", strings.panelTitle, () =>
			void this.openPanel(),
		);
		this.addCommand({
			id: "open-sync-panel",
			name: strings.commandOpenPanel,
			callback: () => void this.openPanel(),
		});
		this.addCommand({
			id: "show-sync-status",
			name: strings.commandShowStatus,
			callback: () =>
				openStatusModal({
					app: this.app,
					state: this.state,
					onSyncNow: () => this.runEngine(false),
					onFullSync: () => this.runEngine(true),
				}),
		});
		this.addCommand({
			id: "test-connection",
			name: strings.commandTestConnection,
			callback: async () => {
				const result = await testConnection(this.settings);
				if (result.ok) {
					new Notice(
						strings.connectionSuccess(
							result.botName,
							result.pageTitle,
						),
					);
				} else {
					new Notice(result.message);
				}
			},
		});
		this.addCommand({
			id: "sync-now",
			name: strings.commandSyncNow,
			callback: () => this.runEngine(false),
		});
		this.addCommand({
			id: "full-sync",
			name: strings.commandFullSync,
			callback: () => this.runEngine(true),
		});
		this.addCommand({
			id: "show-version-history",
			name: strings.commandShowHistory,
			callback: () => {
				const file = this.app.workspace.getActiveFile();
				if (file) {
					void this.openHistory(file.path);
				}
			},
		});
		this.addCommand({
			id: "show-deleted-files",
			name: strings.commandDeletedFiles,
			callback: () => void this.openDeletedFiles(),
		});
		this.addCommand({
			id: "reset-sync-state",
			name: strings.commandResetState,
			callback: () => void this.resetSyncState(),
		});
		this.addCommand({
			id: "reupload-from-local",
			name: strings.commandReupload,
			callback: () => void this.reuploadFromLocal(),
		});
		this.addCommand({
			id: "toggle-pause-sync",
			name: strings.commandTogglePause,
			callback: () => void this.togglePause(),
		});
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile)) return;
				const st = this.state;
				if (!st || !entryByPath(st, file.path)) return;
				menu.addItem((item) => {
					item.setIcon("history")
						.setTitle(getStrings().menuVersionHistory)
						.onClick(() => void this.openHistory(file.path));
				});
			}),
		);

		// preload state so the file-menu can check entries
		const rootId = parseNotionId(this.settings.rootPage);
		if (rootId && this.settings.token.trim()) {
			const loaded = await loadStateChecked(
				this.app,
				this.manifest.dir ?? "",
				rootId,
			);
			this.state = loaded.state;
			this.stateProblem = loaded.problem ?? null;
			this.updateStatus();
		}

		// rename hints: local renames between rounds become base-path remaps
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				// engine-caused renames are consumed, not hinted
				if (this.io?.renames.consume(oldPath, file.path)) return;
				const st = this.state;
				if (!st || autoSyncIgnoresPath(oldPath, this.app.vault.configDir))
					return;
				const isFolder = file instanceof TFolder;
				st.renameHints = st.renameHints ?? [];
				st.renameHints.push({ from: oldPath, to: file.path });
				if (!isFolder) {
					// entry paths update immediately too
					const found = entryByPath(st, oldPath);
					if (found) found.entry.path = file.path;
				}
				const state = st;
				void saveState(this.app, this.manifest.dir ?? "", state);
			}),
		);

		// automatic triggers (debounced changes, interval, startup, foreground)
		wireAutoSync(
			{
				registerEvent: (ref) => this.registerEvent(ref as never),
				registerInterval: (id) => this.registerInterval(id),
				registerDomEvent: (el, type, cb) =>
					this.registerDomEvent(
						el,
						type as "visibilitychange",
						cb,
					),
				onVaultEvent: (type, cb) => {
					const w = (f: { path: string }, o?: string) =>
						cb(f.path, o);
					switch (type) {
						case "modify":
							return this.app.vault.on("modify", w);
						case "create":
							return this.app.vault.on("create", w);
						case "delete":
							return this.app.vault.on("delete", w);
						default:
							return this.app.vault.on("rename", w);
					}
				},
				onLayoutReady: (cb) => this.app.workspace.onLayoutReady(cb),
			},
			{
				getSettings: () => this.settings,
				getState: () => this.state,
				getVaultIO: () => this.io,
				configDir: () => this.app.vault.configDir,
				/** Manual rounds stay available while paused — "pause" stops the
				 * automatic ones only. */
				request: async () => {
					this.nextTrigger = "auto";
					if (!(await this.syncDeps())) {
						throw new Error("sync not configured");
					}
					try {
						return await this.getRunner().request(false);
					} catch (err) {
						this.syncLog.error(
							getStrings().logRoundFailed(
								err instanceof Error
									? err.message
									: String(err),
							),
						);
						void this.syncLog.flush();
						this.setSyncing(false);
						throw err;
					}
				},
				onReport: (r) => this.handleAutoReport(r),
				onChange: () => this.schedulePendingScan(),
			},
		);
	}

	private async historyDeps() {
		const deps = await this.syncDeps();
		if (!deps) return null;
		return {
			app: this.app,
			client: deps.client,
			state: deps.state,
			saveState: deps.saveState,
			deviceId: deps.deviceId,
			history: deps.history!,
			historyPageCache: deps.historyPageCache,
			vault: deps.vault,
			log: deps.log,
		};
	}

	private async openHistory(path: string): Promise<void> {
		const strings = getStrings();
		const deps = await this.historyDeps();
		if (!deps) return;
		const found = entryByPath(deps.state, path);
		if (!found) {
			new Notice(strings.historyNotSynced);
			return;
		}
		openHistoryModal(deps, path);
	}

	private async openDeletedFiles(): Promise<void> {
		const deps = await this.historyDeps();
		if (!deps) return;
		openDeletedFilesModal(deps);
	}

	private adapterIO(dir: string): TextIO {
		const adapter = this.app.vault.adapter;
		return {
			read: (p) => adapter.read(p),
			write: async (p, c) => {
				const idx = p.lastIndexOf("/");
				if (idx > 0) {
					await adapter.mkdir(p.slice(0, idx)).catch(() => undefined);
				}
				await adapter.write(p, c);
			},
			remove: (p) =>
				adapter.exists(p).then((yes) =>
					yes ? adapter.remove(p) : Promise.resolve(),
				),
		};
	}

	private async syncDeps(): Promise<EngineDeps | null> {
		const strings = getStrings();
		const rootId = parseNotionId(this.settings.rootPage);
		if (!this.settings.token.trim() || !rootId) {
			new Notice(strings.missingToken);
			return null;
		}
		if (!this.state || this.state.rootPageId !== rootId) {
			const loaded = await loadStateChecked(
				this.app,
				this.manifest.dir ?? "",
				rootId,
			);
			this.state = loaded.state;
			this.stateProblem = loaded.problem ?? null;
			if (loaded.problem) {
				this.syncLog.error(
					getStrings().logStateUnreadable(
						loaded.problem.kind,
						loaded.problem.bytes,
						loaded.problem.detail,
					),
				);
				void this.syncLog.flush();
			}
		}
		const state = this.state;
		this.io = this.io ?? new ObsidianVaultIO(this.app);
		return {
			vault: this.io,
			client: new NotionClient({ token: this.settings.token.trim() }),
			state,
			saveState: () =>
				saveState(this.app, this.manifest.dir ?? "", state),
			resolvePath: makePathResolver(this.app),
			deviceId: this.settings.deviceId,
			history: {
				enabled: this.settings.historyEnabled,
				intervalMinutes: this.settings.historyIntervalMinutes,
				maxVersions: this.settings.historyMaxVersions,
				retentionDays: this.settings.historyRetentionDays,
			},
			historyPageCache: new Map(),
			baseStore: new BaseStore(
				this.adapterIO(this.manifest.dir ?? ""),
				this.manifest.dir ?? "",
			),
			configIO: new ObsidianConfigIO(this.app, this.app.vault.configDir),
			configSync: this.settings.configSync,
			selfId: this.manifest.id,
			stateProblem: this.stateProblem,
			isMobile: Platform.isMobile,
			engine: {
				fullAuditHours: this.settings.fullAuditHours,
				roundRobinPerRound: ROUND_ROBIN_PER_ROUND,
				maxFileSizeMB: this.settings.maxFileSizeMB,
				deleteGuardThreshold: this.settings.deleteGuardThreshold,
				scope: this.settings.scope,
			},
			confirmLocalDeletes: (paths) => this.guardLocalDeletes(paths),
			log: (m) => {
				console.warn(`[notion-hub-sync] ${m}`);
				if (/warning|fail|error/i.test(m)) this.syncLog.warn(m);
			},
			progress: (done, total) => {
				this.statusEl?.setText(
					`NHS ${getStrings().syncProgress(done, total)}`,
				);
			},
			event: (ev) => this.onSyncEvent(ev),
		};
	}

	/** Bulk local-delete confirmation via modal; logs the decision. */
	private async guardLocalDeletes(
		paths: string[],
	): Promise<"delete" | "keep" | "cancel"> {
		const strings = getStrings();
		const choice = await confirmLocalDeletes(this.app, paths);
		this.syncLog.warn(
			choice === "delete"
				? strings.logGuardDeleted(paths.length)
				: choice === "keep"
					? strings.logGuardKept(paths.length)
					: strings.logGuardCancelled(paths.length),
		);
		void this.syncLog.flush();
		return choice;
	}

	private triggerLabel(): string {
		const strings = getStrings();
		return this.nextTrigger === "full"
			? strings.triggerFull
			: this.nextTrigger === "auto"
				? strings.triggerAuto
				: strings.triggerManual;
	}

	private getRunner(): SyncRunner {
		this.runner =
			this.runner ??
			new SyncRunner(
				async () => {
					this.setSyncing(true);
					this.roundStartAt = Date.now();
					this.syncLog.info(
						getStrings().logRoundStarted(this.triggerLabel()),
					);
					return this.syncDeps();
				},
				(r) => this.logRound(r),
			);
		return this.runner;
	}

	/** Record a finished round in the panel log, then persist. */
	private logRound(r: SyncReport): void {
		const strings = getStrings();
		for (const w of r.warnings) this.syncLog.warn(w);
		for (const c of r.conflictCopies) {
			this.syncLog.warn(strings.logConflictCopy(c), c);
		}
		// One line per blocked file, with the reason — a skipped file that
		// shows nothing is indistinguishable from one that synced.
		for (const b of r.blocked) {
			this.syncLog.warn(
				`${strings.blockedHeadline(1)}: ${b.path} — ${strings.blockedReason(b.reason)}`,
				b.path,
			);
		}
		const secs = ((Date.now() - this.roundStartAt) / 1000).toFixed(1);
		const summary = `${strings.syncDone(
			r.created,
			r.updated,
			r.skipped,
			r.failed,
		)} · ${secs}s`;
		if (r.failed === 0) {
			this.syncLog.success(summary);
		} else {
			this.syncLog.error(summary);
		}
		void this.syncLog.flush();
		this.setSyncing(false);
		this.schedulePendingScan();
	}

	/** Engine activity → sync log + panel progress. */
	private onSyncEvent(ev: SyncEvent): void {
		const strings = getStrings();
		switch (ev.t) {
			case "phase": {
				const text =
					ev.phase === "scanLocal"
						? strings.phaseScanLocal
						: ev.phase === "scanRemote"
							? strings.phaseScanRemote
							: ev.phase === "plan"
								? ev.count && ev.count > 0
									? strings.phasePlan(ev.count)
									: strings.phasePlanEmpty
								: ev.phase === "config"
									? strings.phaseConfig
									: ev.phase === "download"
										? strings.phaseDownload
										: ev.phase === "upload"
											? strings.phaseUpload
											: ev.phase === "apply"
												? strings.phaseApply
												: strings.phaseJournal;
				this.syncLog.info(text);
				this.forEachPanel((v) => v.setActivity(text));
				break;
			}
			case "stage": {
				// In-flight detail (a download ticking bytes): the panel bar stays
				// indeterminate but names what is actually running.
				const text = strings.phaseStage(
					ev.stage,
					ev.done ?? null,
					ev.total ?? null,
				);
				const line =
					ev.label && ev.label !== text ? `${text} · ${ev.label}` : text;
				this.statusEl?.setText(
					ev.done !== undefined && ev.total !== undefined
						? `NHS ${ev.done}/${ev.total}`
						: "NHS …",
				);
				if (ev.done !== undefined && ev.total !== undefined) {
					this.forEachPanel((v) => v.setProgress(ev.done!, ev.total!, line));
				} else {
					this.forEachPanel((v) => v.setActivity(line));
				}
				break;
			}
			case "action": {
				const verb = strings.actionVerb(ev.action);
				const line = `[${ev.done}/${ev.total}] ${verb} ${ev.path}`;
				// apply.ts emits this after applyOne, so `ok` distinguishes a
				// finished action from one that failed (actionFailed follows).
				if (ev.ok) this.syncLog.success(line, ev.path);
				else this.syncLog.error(line, ev.path);
				this.forEachPanel((v) =>
					v.setProgress(ev.done, ev.total, `${verb} ${ev.path}`),
				);
				break;
			}
			case "actionFailed": {
				this.syncLog.error(
					strings.logActionFailed(
						strings.actionVerb(ev.action),
						ev.path,
						ev.error,
					),
					ev.path,
				);
				break;
			}
			case "scan": {
				const text =
					ev.stage === "local"
						? strings.scanHashed(ev.done, ev.total ?? 0)
						: ev.stage === "walk"
							? strings.scanWalked(ev.done)
							: strings.scanEvaluating(ev.done, ev.total ?? 0);
				this.statusEl?.setText(
					ev.total !== undefined
						? `NHS ${ev.done}/${ev.total}`
						: `NHS ${ev.done}`,
				);
				const label = `${text} · ${ev.label}`;
				if (ev.total !== undefined) {
					this.forEachPanel((v) =>
						v.setProgress(ev.done, ev.total!, label),
					);
				} else {
					this.forEachPanel((v) => v.setActivity(label));
				}
				break;
			}
			case "upload": {
				if (ev.parts > 1) {
					const text = strings.logUploadPart(
						ev.part,
						ev.parts,
						ev.path,
					);
					this.syncLog.success(text, ev.path);
					this.forEachPanel((v) =>
						v.setProgress(ev.part, ev.parts, text),
					);
				} else {
					this.syncLog.success(
						strings.logUploaded(ev.path, formatSize(ev.bytes)),
						ev.path,
					);
				}
				break;
			}
		}
	}

	private panelDeps(): SyncPanelDeps {
		return {
			log: this.syncLog,
			getState: () => this.state,
			isSyncing: () => this.syncing,
			isPaused: () => this.settings.paused,
			getChanges: () => this.pendingCache,
			onOpenPath: (path) => this.openVaultPath(path),
			onSyncNow: () => void this.runEngine(false),
			onFullSync: () => void this.runEngine(true),
			onTogglePause: () => void this.togglePause(),
			onRefreshChanges: () => this.schedulePendingScan(),
			onOpenStatus: () =>
				openStatusModal({
					app: this.app,
					state: this.state,
					onSyncNow: () => this.runEngine(false),
					onFullSync: () => this.runEngine(true),
				}),
			onOpenHistory: () => {
				const file = this.app.workspace.getActiveFile();
				if (file) void this.openHistory(file.path);
			},
			onDeletedFiles: () => void this.openDeletedFiles(),
		};
	}

	/** Log-row click: open the file (or reveal the folder) in Obsidian. */
	private openVaultPath(path: string): void {
		const strings = getStrings();
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) {
			new Notice(strings.logPathMissing(path));
			return;
		}
		if (!(file instanceof TFile)) {
			// folders have no view — reveal the node in the file explorer
			const explorer = this.app.workspace.getLeavesOfType(
				"file-explorer",
			)[0];
			if (explorer) {
				void this.app.workspace.revealLeaf(explorer);
				(
					explorer.view as unknown as {
						revealInFolder?: (folder: TFolder) => void;
					}
				).revealInFolder?.(file as TFolder);
			}
			return;
		}
		// already open somewhere → focus it instead of stacking tabs
		let open: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view as unknown as { file?: TFile };
			if (view.file?.path === path) open = leaf;
		});
		if (open) {
			this.app.workspace.setActiveLeaf(open, { focus: true });
			return;
		}
		void this.app.workspace.getLeaf("tab").openFile(file);
	}

	private async openPanel(): Promise<void> {
		let leaf =
			this.app.workspace.getLeavesOfType(SYNC_PANEL_VIEW)[0] ?? null;
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: SYNC_PANEL_VIEW, active: true });
		}
		void this.app.workspace.revealLeaf(leaf);
	}

	private forEachPanel(fn: (view: SyncPanelView) => void): void {
		for (const leaf of this.app.workspace.getLeavesOfType(
			SYNC_PANEL_VIEW,
		)) {
			if (leaf.view instanceof SyncPanelView) fn(leaf.view);
		}
	}

	private async loadSyncLog(): Promise<void> {
		try {
			const path = `${this.manifest.dir ?? ""}/sync-log.json`;
			if (await this.app.vault.adapter.exists(path)) {
				this.syncLog.load(
					JSON.parse(await this.app.vault.adapter.read(path)),
				);
			}
		} catch {
			// missing or corrupt log file — start fresh
		}
	}

	/** Command: clear this device's sync record, then re-match by path. */
	private async resetSyncState(): Promise<void> {
		const strings = getStrings();
		if (this.syncing) {
			new Notice(strings.noticeSyncBusy);
			return;
		}
		if (
			!(await confirmAction(this.app, {
				title: strings.commandResetState,
				text: strings.confirmResetStateText,
			}))
		) {
			return;
		}
		const deps = await this.syncDeps();
		if (!deps) return;
		// The whole point of this command is to start from a clean record —
		// a corrupted file must not survive it, or the next load reads the
		// same bytes and lands in the same loop.
		if (this.stateProblem) {
			const moved = await quarantineState(
				this.app,
				this.manifest.dir ?? "",
				String(Date.now()),
			);
			if (moved) this.syncLog.warn(strings.logStateQuarantined(moved));
			this.stateProblem = null;
		}
		resetState(deps.state);
		await deps.saveState();
		this.syncLog.warn(strings.logResetState);
		void this.syncLog.flush();
		this.updateStatus();
		// No forced full audit: the path re-match below walks the remote tree
		// anyway, and forcing `full` only adds a second whole-workspace scan
		// on top of a round that is already the expensive one.
		void this.runEngine(false);
	}

	/** Command: trash every page under the Notion root, then re-upload. */
	private async reuploadFromLocal(): Promise<void> {
		const strings = getStrings();
		if (this.syncing) {
			new Notice(strings.noticeSyncBusy);
			return;
		}
		if (
			!(await confirmAction(this.app, {
				title: strings.commandReupload,
				text: strings.confirmReuploadText,
				warning: true,
			}))
		) {
			return;
		}
		const deps = await this.syncDeps();
		if (!deps) return;
		this.setSyncing(true);
		try {
			const n = await clearRemote(
				{ client: deps.client, state: deps.state },
				(done, total) =>
					this.forEachPanel((v) =>
						v.setProgress(done, total, strings.commandReupload),
					),
			);
			this.syncLog.info(strings.logClearRemote(n));
		} catch (err) {
			this.setSyncing(false);
			new Notice(
				strings.connectionFailed(
					err instanceof Error ? err.message : String(err),
				),
			);
			return;
		}
		resetState(deps.state);
		await deps.saveState();
		this.setSyncing(false);
		void this.runEngine(true);
	}

	private async runEngine(full: boolean): Promise<void> {
		const strings = getStrings();
		if (!(await this.syncDeps())) {
			return; // missing config — syncDeps already Noticed
		}
		this.nextTrigger = full ? "full" : "manual";
		this.setSyncing(true);
		new Notice(strings.syncStarted);
		try {
			const report: SyncReport = await this.getRunner().request(full);
			const summary = strings.syncDone(
				report.created,
				report.updated,
				report.skipped,
				report.failed,
			);
			const issues = [...report.failures, ...report.warnings];
			const tail =
				issues.length > 0
					? `\n${issues.slice(0, 5).join("\n")}`
					: "";
			new Notice(`${summary}${tail}`, 15000);
			if (report.blocked.length > 0) {
				const sum = summarizeBlocked(
					report.blocked,
					blockedLabels(strings),
				);
				new Notice(
					strings.blockedNoticeDetail(sum.count, sum.detail),
					15000,
				);
			}
			if (report.configWritten) {
				this.notifyConfigReload();
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.syncLog.error(strings.logRoundFailed(msg));
			void this.syncLog.flush();
			new Notice(strings.connectionFailed(msg));
		} finally {
			this.setSyncing(false);
		}
	}

	/** Silent auto rounds: Notice only on failures / conflicts / config
	 * reload; status UI always refreshes. */
	private handleAutoReport(report: SyncReport): void {
		const strings = getStrings();
		if (report.configWritten) this.notifyConfigReload();
		if (report.failed > 0) {
			const issues = [...report.failures, ...report.warnings];
			new Notice(
				`${strings.syncDone(report.created, report.updated, report.skipped, report.failed)}` +
					(issues.length > 0 ? `\n${issues.slice(0, 5).join("\n")}` : ""),
				15000,
			);
		}
		if (report.conflictCopies.length > 0) {
			new Notice(strings.conflictNotice(report.conflictCopies.length), 15000);
		}
		if (report.blocked.length > 0) {
			// Say WHY, not just how many: "3 files blocked" leaves the user
			// guessing which ones and what to do about it.
			const sum = summarizeBlocked(report.blocked, blockedLabels(strings));
			new Notice(
				strings.blockedNoticeDetail(sum.count, sum.detail),
				15000,
			);
		}
		this.forEachPanel((v) => v.hideProgress());
		this.updateStatus();
	}

	private setSyncing(on: boolean): void {
		this.syncing = on;
		if (!on) this.forEachPanel((v) => v.hideProgress());
		this.updateStatus();
	}

	private updateStatus(): void {
		const strings = getStrings();
		this.forEachPanel((v) => v.refresh());
		const st = this.state;
		const paused = this.settings.paused;
		this.ribbonEl?.toggleClass("nhs-ribbon-paused", paused);
		if (this.syncing) {
			this.statusEl?.setText("NHS …");
			this.ribbonEl?.addClass("nhs-ribbon-spinning");
			this.ribbonEl?.setAttribute("aria-label", strings.statusRunning);
			this.ribbonEl?.setAttribute("title", strings.statusRunning);
			return;
		}
		this.ribbonEl?.removeClass("nhs-ribbon-spinning");
		const last = st?.lastSyncAt;
		const failed = (st?.lastReport?.failed ?? 0) > 0;
		const conflicts = st?.lastReport?.conflictCopies.length ?? 0;
		const blocked = st?.lastReport?.blocked?.length ?? 0;
		const pending = this.pendingCache.length;
		const bad = failed || conflicts > 0 || blocked > 0;
		this.ribbonEl?.toggleClass("nhs-ribbon-warn", bad && !paused);
		this.setRibbonBadge(bad && !paused);
		const time = last
			? new Date(last).toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
				})
			: null;
		// Order mirrors urgency: paused first (nothing will happen), then
		// anything a user must act on, then the timestamps.
		const tip = strings.ribbonLabel({
			paused,
			syncing: false,
			failed,
			blocked,
			conflicts,
			pending,
			lastSync: time,
		});
		this.ribbonEl?.setAttribute("aria-label", tip);
		this.ribbonEl?.setAttribute("title", tip);
		this.statusEl?.setText(
			paused
				? strings.pausedLabel
				: time
					? strings.syncDoneAt(time)
					: "",
		);
	}

	/** Warning dot on the ribbon icon.
	 *
	 * A real child node, not a `::after` pseudo-element: mobile renders the
	 * ribbon as menu items and drops pseudo-elements, which silently lost the
	 * indicator on phones. Idempotent — reconcile instead of toggling so a
	 * theme re-render can't leave two dots. */
	private setRibbonBadge(on: boolean): void {
		const el = this.ribbonEl;
		if (!el) return;
		const existing = el.querySelector<HTMLElement>(".nhs-ribbon-badge");
		if (!on) {
			existing?.remove();
			return;
		}
		if (existing) return;
		const dot = el.createSpan({ cls: "nhs-ribbon-badge" });
		dot.setAttribute("aria-hidden", "true");
	}

	/** Toggle the pause hold. Manual sync stays available on purpose. */
	private async togglePause(): Promise<void> {
		const strings = getStrings();
		this.settings.paused = !this.settings.paused;
		await this.saveSettings();
		new Notice(
			this.settings.paused ? strings.pausedNotice : strings.resumedNotice,
		);
		this.updateStatus();
	}

	/** Recompute the panel's "pending changes" list (debounced; read-only). */
	private schedulePendingScan(): void {
		if (this.pendingTimer !== null) window.clearTimeout(this.pendingTimer);
		this.pendingTimer = window.setTimeout(() => {
			this.pendingTimer = null;
			void this.scanPending();
		}, 400);
	}

	private async scanPending(): Promise<void> {
		const st = this.state;
		if (!st || this.pendingScanning) return;
		this.pendingScanning = true;
		try {
			const files = this.app.vault.getFiles().map((f) => ({
				path: f.path,
				size: f.stat.size,
				mtime: f.stat.mtime,
			}));
			this.pendingCache = scanPendingChanges({
				state: st,
				files,
				blocked: st.lastReport?.blocked ?? [],
				scope: this.settings.scope,
				renameHints: st.renameHints ?? [],
			});
		} finally {
			this.pendingScanning = false;
		}
		this.forEachPanel((v) => v.setChanges(this.pendingCache));
		this.updateStatus();
	}

	/** Change row click: open the file, or explain why it can't be opened.
	 * Delegates to the log-row handler so both paths behave identically
	 * (a vanished path must show the same notice either way). */
	private openPending(path: string): void {
		this.openVaultPath(path);
	}

	/** Notice with a Reload button — never auto-reloads. */
	private notifyConfigReload(): void {
		const strings = getStrings();
		const frag = document.createDocumentFragment();
		frag.appendText(strings.configReloadNotice + " ");
		const btn = frag.createEl("button", { text: strings.configReloadButton });
		btn.addEventListener("click", () => {
			// app.commands is not in the public typings but is stable API
			(
				this.app as unknown as {
					commands: { executeCommandById(id: string): void };
				}
			).commands.executeCommandById("app:reload");
		});
		new Notice(frag, 0);
	}

	async loadSettings(): Promise<void> {
		const saved = await this.loadData();
		this.settings = mergeSettings(saved);
		if (!this.settings.deviceId) {
			this.settings.deviceId = newDeviceId();
			await this.saveSettings();
		}
		setOverriddenLocale(this.settings.language);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** crypto.randomUUID fallback for older iOS WebViews (< 15.4). */
function newDeviceId(): string {
	if (typeof crypto !== "undefined" && crypto.randomUUID) {
		return crypto.randomUUID();
	}
	const hex = () =>
		Math.floor(Math.random() * 0xffffffff)
			.toString(16)
			.padStart(8, "0");
	return `${hex().slice(0, 8)}-${hex().slice(0, 4)}-4${hex().slice(1, 4)}-8${hex().slice(1, 4)}-${hex()}${hex().slice(0, 4)}`;
}
