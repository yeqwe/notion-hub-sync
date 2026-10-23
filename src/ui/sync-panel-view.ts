// Right-sidebar sync panel, styled after the pickpen reference:
// header + pulsing status badge, actions card (primary + icon grid),
// progress bar, stat cards, last-sync card, and the inline sync log
// card with level filters. Mobile-friendly; log list re-renders
// (debounced) on SyncLog changes.

import { ItemView, setIcon, type WorkspaceLeaf } from "obsidian";

import { getStrings } from "../i18n";
import type { LogLevel, SyncLog } from "../sync/sync-log";
import type { SyncState } from "../sync/state";
import { statusMark, type PendingChange } from "../sync/changes";

export const SYNC_PANEL_VIEW = "nhs-sync-panel";

/** Render at most this many newest log rows. */
const MAX_ROWS = 300;
/** Render at most this many change rows (the card scrolls). */
const MAX_CHANGES = 200;

type LogFilter = "all" | LogLevel;

export interface SyncPanelDeps {
	log: SyncLog;
	getState(): SyncState | null;
	isSyncing(): boolean;
	isPaused(): boolean;
	/** Cached pending-changes list (computed outside the panel). */
	getChanges(): readonly PendingChange[];
	/** Open a vault path from a log row (missing → caller notifies). */
	onOpenPath(path: string): void;
	onSyncNow(): void;
	onFullSync(): void;
	onOpenStatus(): void;
	onOpenHistory(): void;
	onDeletedFiles(): void;
	onTogglePause(): void;
	onRefreshChanges(): void;
}

export class SyncPanelView extends ItemView {
	private badgeEl: HTMLElement | null = null;
	private progressEl: HTMLElement | null = null;
	private progressFillEl: HTMLElement | null = null;
	private progressTextEl: HTMLElement | null = null;
	private statsEl: HTMLElement | null = null;
	private lastSyncEl: HTMLElement | null = null;
	private logEl: HTMLElement | null = null;
	private changesEl: HTMLElement | null = null;
	private pauseBtn: HTMLElement | null = null;
	private filter: LogFilter = "all";
	private unsubscribe: (() => void) | null = null;
	private logTimer: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private readonly deps: SyncPanelDeps,
	) {
		super(leaf);
	}

	getViewType(): string {
		return SYNC_PANEL_VIEW;
	}

	getDisplayText(): string {
		return getStrings().panelTitle;
	}

	getIcon(): string {
		return "activity";
	}

	async onOpen(): Promise<void> {
		this.render();
		this.unsubscribe = this.deps.log.onChange(() =>
			this.scheduleLogRender(),
		);
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (this.logTimer !== null) {
			window.clearTimeout(this.logTimer);
			this.logTimer = null;
		}
	}

	/** Re-render badge + summary (called when sync state changes). */
	refresh(): void {
		this.updateBadge();
		this.renderSummary();
		this.updatePauseButton();
	}

	/** Replace the "pending changes" card's contents. */
	setChanges(changes: readonly PendingChange[]): void {
		this.renderChanges(changes);
	}

	/** Determinate progress: bar % + "done/total · pct%" + label. */
	setProgress(done: number, total: number, label: string): void {
		if (!this.progressEl || !this.progressFillEl || !this.progressTextEl) {
			return;
		}
		const pct =
			total > 0
				? Math.min(100, Math.max(0, Math.round((done / total) * 100)))
				: 0;
		this.progressEl.removeClass("nhs-panel-progress-hidden");
		this.progressEl.removeClass("is-indeterminate");
		this.progressFillEl.setCssProps({ "--fill-width": `${pct}%` });
		this.progressTextEl.empty();
		this.progressTextEl.createSpan({
			cls: "nhs-panel-progress-label",
			text: label,
		});
		this.progressTextEl.createSpan({
			text: `${done}/${total} · ${pct}%`,
		});
	}

	/** Indeterminate activity line: sliding bar until real progress. */
	setActivity(text: string): void {
		if (!this.progressEl || !this.progressFillEl || !this.progressTextEl) {
			return;
		}
		this.progressEl.removeClass("nhs-panel-progress-hidden");
		this.progressEl.addClass("is-indeterminate");
		this.progressTextEl.empty();
		this.progressTextEl.createSpan({
			cls: "nhs-panel-progress-label",
			text,
		});
	}

	hideProgress(): void {
		this.progressEl?.addClass("nhs-panel-progress-hidden");
		this.progressEl?.removeClass("is-indeterminate");
		this.progressFillEl?.setCssProps({ "--fill-width": "0%" });
		this.progressTextEl?.setText("");
	}

	private render(): void {
		const s = getStrings();
		const root = this.contentEl;
		root.empty();
		root.addClass("nhs-panel");

		// ── header + status badge ──────────────────────────────
		const header = root.createDiv({ cls: "nhs-panel-header" });
		const brand = header.createDiv({ cls: "nhs-panel-brand" });
		brand.createEl("h3", { text: s.panelTitle });
		this.badgeEl = header.createDiv();

		// ── actions card ───────────────────────────────────────
		const card = root.createDiv({ cls: "nhs-panel-actions-card" });
		const primary = card.createEl("button", {
			cls: "nhs-panel-btn-primary",
			attr: { "aria-label": s.commandSyncNow },
		});
		setIcon(primary, "refresh-cw");
		primary.createSpan({ text: s.commandSyncNow });
		primary.addEventListener("click", () => this.deps.onSyncNow());

		const grid = card.createDiv({ cls: "nhs-panel-action-grid" });
		this.addGridBtn(
			grid,
			"rotate-cw",
			s.panelGridFull,
			s.commandFullSync,
			() => this.deps.onFullSync(),
		);
		this.addGridBtn(
			grid,
			"alert-triangle",
			s.panelGridStatus,
			s.statusTitle,
			() => this.deps.onOpenStatus(),
		);
		this.addGridBtn(
			grid,
			"history",
			s.panelGridHistory,
			s.commandShowHistory,
			() => this.deps.onOpenHistory(),
		);
		this.addGridBtn(
			grid,
			"trash-2",
			s.panelGridDeleted,
			s.commandDeletedFiles,
			() => this.deps.onDeletedFiles(),
		);
		// Pause sits last in the grid: it is the least-used action but the
		// one you look for in a hurry.
		this.pauseBtn = this.addGridBtn(
			grid,
			"pause",
			s.commandPauseSync,
			s.commandTogglePause,
			() => this.deps.onTogglePause(),
		);

		// ── progress bar ───────────────────────────────────────
		this.progressEl = root.createDiv({
			cls: "nhs-panel-progress nhs-panel-progress-hidden",
		});
		const bar = this.progressEl.createDiv({
			cls: "nhs-panel-progress-bar",
		});
		this.progressFillEl = bar.createDiv({
			cls: "nhs-panel-progress-fill",
		});
		this.progressTextEl = this.progressEl.createDiv({
			cls: "nhs-panel-progress-text",
		});

		// ── stat cards ─────────────────────────────────────────
		this.statsEl = root.createDiv({
			cls: "nhs-panel-stats-container",
		});

		// ── last sync card ─────────────────────────────────────
		const syncCard = root.createDiv({ cls: "nhs-panel-card-section" });
		syncCard.createEl("p", {
			cls: "nhs-panel-card-section-title",
			text: s.panelLastSync,
		});
		this.lastSyncEl = syncCard.createDiv();

		// ── pending changes card (git-status style) ──────────
		this.changesEl = root.createDiv({ cls: "nhs-panel-card-section" });

		// ── log card ───────────────────────────────────────────
		this.logEl = root.createDiv({ cls: "nhs-panel-card-section" });

		this.refresh();
		this.renderChanges(this.deps.getChanges());
		this.renderLog();
	}

	private updatePauseButton(): void {
		if (!this.pauseBtn) return;
		const s = getStrings();
		const paused = this.deps.isPaused();
		this.pauseBtn.toggleClass("is-active", paused);
		this.pauseBtn.setAttribute(
			"aria-label",
			paused ? s.commandResumeSync : s.commandPauseSync,
		);
		const label = this.pauseBtn.querySelector("span");
		if (label) {
			label.setText(paused ? s.commandResumeSync : s.commandPauseSync);
		}
	}

	/** "Pending changes" card: one row per path, `git status` marks.
	 *
	 * Read-only by design — pushing one file alone would need a second,
	 * narrower apply path, and the round is cheap enough that "sync now"
	 * is the honest action. The list exists so a stuck file is *visible*.
	 */
	private renderChanges(changes: readonly PendingChange[]): void {
		const el = this.changesEl;
		if (!el) return;
		const s = getStrings();
		el.empty();
		const head = el.createDiv({ cls: "nhs-panel-log-header" });
		head.createEl("p", {
			cls: "nhs-panel-card-section-title",
			text: s.changesTitle,
		});
		head.createSpan({
			cls: "nhs-panel-log-count",
			text: s.changesCount(changes.length),
		});
		const refresh = head.createEl("button", {
			cls: "nhs-log-filter-btn",
			text: s.changesRefresh,
			attr: { "aria-label": s.changesRefresh },
		});
		refresh.addEventListener("click", () => this.deps.onRefreshChanges());

		const list = el.createDiv({ cls: "nhs-changes-list" });
		if (changes.length === 0) {
			list.createEl("p", { cls: "nhs-log-empty", text: s.changesEmpty });
			return;
		}
		const labels: Record<PendingChange["status"], string> = {
			new: s.changesNew,
			modified: s.changesModified,
			renamed: s.changesRenamed,
			deleted: s.changesDeleted,
		};
		for (const c of changes.slice(0, MAX_CHANGES)) {
			const row = list.createDiv({
				cls: `nhs-change-row is-${c.status} is-clickable`,
			});
			row.setAttribute("title", labels[c.status]);
			row.setAttribute("aria-label", `${labels[c.status]}: ${c.path}`);
			row.createSpan({
				cls: "nhs-change-mark",
				text: statusMark(c.status),
			});
			row.createSpan({ cls: "nhs-change-name", text: c.name });
			const at = c.path.lastIndexOf("/");
			if (at > 0) {
				row.createSpan({ cls: "nhs-change-dir", text: c.path.slice(0, at) });
			}
			row.addEventListener("click", () => this.deps.onOpenPath(c.path));
		}
		if (changes.length > MAX_CHANGES) {
			list.createEl("p", {
				cls: "nhs-log-empty",
				text: `…+${changes.length - MAX_CHANGES}`,
			});
		}
	}

	private updateBadge(): void {
		if (!this.badgeEl) return;
		const s = getStrings();
		const state = this.deps.getState();
		const failed = (state?.lastReport?.failed ?? 0) > 0;
		const syncing = this.deps.isSyncing();
		this.contentEl.toggleClass("is-syncing", syncing);
		this.badgeEl.empty();
		this.badgeEl.className = `nhs-panel-status-badge ${
			syncing
				? "status-syncing"
				: failed
					? "status-error"
					: "status-connected"
		}`;
		this.badgeEl.createDiv({ cls: "nhs-panel-pulsing-dot" });
		this.badgeEl.createSpan({
			text: syncing
				? s.panelSyncing
				: failed
					? s.panelError
					: s.panelReady,
		});
	}

	private renderSummary(): void {
		if (!this.statsEl || !this.lastSyncEl) return;
		const s = getStrings();
		const st = this.deps.getState();
		const r = st?.lastReport;

		this.statsEl.empty();
		const card = (
			value: number,
			label: string,
			isError = false,
		): void => {
			const el = this.statsEl!.createDiv({
				cls: `nhs-panel-stat-card${isError ? " is-error" : ""}`,
			});
			el.createDiv({
				cls: "nhs-panel-stat-val",
				text: String(value),
			});
			el.createDiv({ cls: "nhs-panel-stat-lbl", text: label });
		};
		card(r?.created ?? 0, s.statCreated);
		card(r?.updated ?? 0, s.statUpdated);
		card(r?.skipped ?? 0, s.statSkipped);
		card(r?.failed ?? 0, s.statFailed, (r?.failed ?? 0) > 0);

		this.lastSyncEl.empty();
		const row = this.lastSyncEl.createDiv({
			cls: "nhs-panel-last-sync-block",
		});
		setIcon(row, "clock");
		row.createSpan({
			text: st?.lastSyncAt
				? new Date(st.lastSyncAt).toLocaleString()
				: s.statusNever,
		});
		const conflicts = r?.conflictCopies.length ?? 0;
		if (conflicts > 0) {
			const crow = this.lastSyncEl.createDiv({
				cls: "nhs-panel-last-sync-block is-bordered is-error",
			});
			setIcon(crow, "alert-triangle");
			crow.createSpan({ text: s.panelConflicts(conflicts) });
		}
	}

	private scheduleLogRender(): void {
		if (this.logTimer !== null) window.clearTimeout(this.logTimer);
		this.logTimer = window.setTimeout(() => {
			this.logTimer = null;
			this.renderLog();
		}, 250);
	}

	private renderLog(): void {
		if (!this.logEl) return;
		const s = getStrings();
		const entries = this.deps.log.entries();
		this.logEl.empty();

		const head = this.logEl.createDiv({ cls: "nhs-panel-log-header" });
		head.createEl("p", {
			cls: "nhs-panel-card-section-title",
			text: s.panelLogTitle,
		});
		head.createSpan({
			cls: "nhs-panel-log-count",
			text: String(entries.length),
		});

		const bar = this.logEl.createDiv({ cls: "nhs-log-filter" });
		const filters: [LogFilter, string][] = [
			["all", s.logFilterAll],
			["info", s.logFilterInfo],
			["success", s.logFilterSuccess],
			["warn", s.logFilterWarn],
			["error", s.logFilterError],
		];
		for (const [key, label] of filters) {
			const btn = bar.createEl("button", {
				cls: `nhs-log-filter-btn${this.filter === key ? " nhs-log-filter-btn--active" : ""}`,
				text: label,
			});
			btn.addEventListener("click", () => {
				this.filter = key;
				this.renderLog();
			});
		}
		const clearBtn = bar.createEl("button", {
			cls: "nhs-log-filter-btn nhs-log-clear-btn",
			text: s.logClear,
			attr: { "aria-label": s.logClear },
		});
		clearBtn.addEventListener("click", () => this.deps.log.clear());

		const list = this.logEl.createDiv({ cls: "nhs-log-entries" });
		const filtered = entries.filter(
			(e) => this.filter === "all" || e.level === this.filter,
		);
		if (filtered.length === 0) {
			list.createEl("p", {
				cls: "nhs-log-empty",
				text: s.logEmpty,
			});
			return;
		}
		const levelLabel: Record<LogLevel, string> = {
			info: s.logFilterInfo,
			success: s.logFilterSuccess,
			warn: s.logFilterWarn,
			error: s.logFilterError,
		};
		for (const e of filtered.slice(-MAX_ROWS).reverse()) {
			const path = e.path;
			const row = list.createDiv({
				cls: `nhs-log-entry nhs-log-${e.level}${path ? " is-clickable" : ""}`,
			});
			const time = new Date(e.t).toLocaleTimeString([], {
				hour12: false,
			});
			row.createSpan({
				cls: "nhs-log-time",
				text: `[${time}] `,
			});
			row.createSpan({
				cls: "nhs-log-tag",
				text: `[${levelLabel[e.level]}] `,
			});
			if (!path) {
				row.createSpan({ text: e.msg });
				continue;
			}
			row.setAttribute("title", s.logOpenPath(path));
			row.addEventListener("click", () => this.deps.onOpenPath(path));
			// the path inside the message becomes the clickable part
			const at = e.msg.indexOf(path);
			if (at < 0) {
				row.createSpan({ text: e.msg });
				continue;
			}
			if (at > 0) row.createSpan({ text: e.msg.slice(0, at) });
			row.createSpan({ cls: "nhs-log-path", text: path });
			const rest = e.msg.slice(at + path.length);
			if (rest) row.createSpan({ text: rest });
		}
	}

	private addGridBtn(
		container: HTMLElement,
		iconName: string,
		label: string,
		tooltip: string,
		onClick: () => void,
	): HTMLElement {
		const btn = container.createEl("button", {
			cls: "nhs-panel-grid-btn",
			attr: { "aria-label": tooltip },
		});
		setIcon(btn, iconName);
		btn.createSpan({ text: label });
		btn.addEventListener("click", onClick);
		return btn;
	}
}
