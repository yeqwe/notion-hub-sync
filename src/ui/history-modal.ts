// Version history modal: left = version list (newest first, paged),
// right = preview (Markdown-rendered text, binary notice, or a line diff
// against the current file). Restore writes the version bytes back through
// VaultIO after snapshotting the current content as a "restore" version.

import {
	App,
	ButtonComponent,
	Component,
	MarkdownRenderer,
	Modal,
	Notice,
	Platform,
	ToggleComponent,
} from "obsidian";

import { getStrings } from "../i18n";
import type { SyncState } from "../sync/state";
import { entryByPath } from "../sync/state";
import type { VaultIO } from "../sync/vault-io";
import { basename, parentDir } from "../sync/vault-io";
import {
	downloadVersion,
	listVersions,
	recordVersion,
	type HistoryDeps,
	type VersionInfo,
} from "../sync/history";
import { sha256Hex } from "../sync/hashes";
import { diffTexts, type DiffLine } from "../history/history-diff";

export type HistoryUiDeps = HistoryDeps & {
	app: App;
	vault: VaultIO;
};

export function formatSize(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(iso: string): string {
	const t = Date.parse(iso);
	return Number.isFinite(t)
		? new Date(t).toLocaleString()
		: iso;
}

/** First 8KB containing \x00 counts as binary. */
export function isBinaryContent(content: Uint8Array): boolean {
	const limit = Math.min(content.byteLength, 8192);
	for (let i = 0; i < limit; i++) {
		if (content[i] === 0) return true;
	}
	return false;
}

function reasonText(reason: string): string | null {
	const s = getStrings();
	if (reason === "pre-pull") return s.reasonPrePull;
	if (reason === "pre-delete") return s.reasonPreDelete;
	if (reason === "restore") return s.reasonRestore;
	if (reason === "push") return s.reasonPush;
	return null;
}

/** File-menu/command entry point. Returns false when the file is unsynced. */
export function hasHistoryEntry(state: SyncState, path: string): boolean {
	return entryByPath(state, path) !== null;
}

export function openHistoryModal(deps: HistoryUiDeps, path: string): void {
	new HistoryModal(deps, path).open();
}

class HistoryModal extends Modal {
	private readonly deps: HistoryUiDeps;
	private readonly pageId: string;
	private readonly historyPageId: string | null;
	private readonly path: string;

	private versions: VersionInfo[] = [];
	private nextCursor: string | null = null;
	private hasMore = false;
	private loading = false;
	private closed = false;
	private restoring = false;
	private generation = 0;
	private selected: VersionInfo | null = null;
	private selectedContent: Uint8Array | null = null;
	private selectedText: string | null = null;
	private selectedBinary = false;
	private showDiff = false;
	private markdownComponent: Component | null = null;

	private listEl!: HTMLElement;
	private previewHeadEl!: HTMLElement;
	private actionRowEl!: HTMLElement;
	private previewBodyEl!: HTMLElement;
	private mainEl!: HTMLElement;
	private detailOpen = false;

	constructor(deps: HistoryUiDeps, path: string) {
		super(deps.app);
		this.deps = deps;
		this.path = path;
		const found = entryByPath(deps.state, path);
		this.pageId = found?.pageId ?? "";
		this.historyPageId = found?.entry.historyPageId ?? null;
		this.modalEl.classList.add("nhs-history-modal");
		if (Platform.isMobile) this.modalEl.classList.add("is-mobile");
	}

	async onOpen(): Promise<void> {
		const s = getStrings();
		const { contentEl } = this;
		contentEl.empty();
		if (Platform.isMobile) {
			this.mainEl = contentEl.createDiv({ cls: "nhs-history-mobile-main" });
			this.mountMobileList();
		} else {
			contentEl.createEl("h3", {
				text: `${s.menuVersionHistory}: ${basename(this.path)}`,
			});
			contentEl.createDiv({
				cls: "nhs-history-path",
				text: this.path,
			});
			this.mainEl = contentEl.createDiv({ cls: "nhs-history-split" });
			const listPane = this.mainEl.createDiv({
				cls: "nhs-history-list-pane",
			});
			this.listEl = listPane.createDiv({ cls: "nhs-history-list" });
			const previewPane = this.mainEl.createDiv({
				cls: "nhs-history-pane",
			});
			this.previewHeadEl = previewPane.createDiv({
				cls: "nhs-history-preview-head",
			});
			this.actionRowEl = previewPane.createDiv({
				cls: "nhs-history-actions",
			});
			this.previewBodyEl = previewPane.createDiv({
				cls: "nhs-history-preview markdown-preview-view",
			});
			this.previewHeadEl.createDiv({
				cls: "nhs-history-message",
				text: s.historySelectVersion,
			});
		}
		await this.loadVersions(true);
	}

	onClose(): void {
		this.closed = true;
		this.generation++;
		this.disposeMarkdown();
		this.contentEl.empty();
	}

	// ---- mobile two-screen layout ----

	private mountMobileList(): void {
		this.detailOpen = false;
		this.mainEl.empty();
		this.listEl = this.mainEl.createDiv({
			cls: "nhs-history-list is-mobile",
		});
		if (this.versions.length > 0) this.renderList();
		else if (this.loading)
			this.renderLoading(this.listEl, getStrings().historyLoading);
	}

	private mountMobileDetail(): void {
		this.detailOpen = true;
		this.mainEl.empty();
		this.listEl = createDiv(); // detached — renderList won't paint
		new ButtonComponent(
			this.mainEl.createDiv({ cls: "nhs-history-mobile-actions" }),
		)
			.setButtonText(getStrings().historyBack)
			.onClick(() => this.mountMobileList());
		this.actionRowEl = this.mainEl.createDiv({
			cls: "nhs-history-actions is-mobile",
		});
		this.previewHeadEl = this.mainEl.createDiv({
			cls: "nhs-history-preview-head is-mobile",
		});
		this.previewBodyEl = this.mainEl.createDiv({
			cls: "nhs-history-preview is-mobile markdown-preview-view",
		});
	}

	// ---- version list ----

	private async loadVersions(first: boolean): Promise<void> {
		if (this.loading || this.closed) return;
		const s = getStrings();
		if (!this.historyPageId) {
			this.listEl.empty();
			this.listEl.createDiv({
				cls: "nhs-history-message",
				text: s.historyEmpty,
			});
			return;
		}
		this.loading = true;
		if (first && this.versions.length === 0) {
			this.renderLoading(this.listEl, s.historyLoading);
		}
		try {
			const res = await listVersions(
				this.deps.client,
				this.historyPageId,
				first ? undefined : (this.nextCursor ?? undefined),
			);
			if (this.closed) return;
			if (first) this.versions = [];
			this.versions.push(...res.versions);
			this.nextCursor = res.nextCursor;
			this.hasMore = res.hasMore;
			if (!Platform.isMobile || !this.detailOpen) this.renderList();
		} catch (err) {
			if (this.closed) return;
			this.listEl.empty();
			this.listEl.createDiv({
				cls: "nhs-history-message is-error",
				text: s.historyVersionLoadFailed(
					err instanceof Error ? err.message : String(err),
				),
			});
		} finally {
			this.loading = false;
		}
	}

	private renderList(): void {
		const s = getStrings();
		this.listEl.empty();
		if (this.versions.length === 0) {
			this.listEl.createDiv({
				cls: "nhs-history-message",
				text: s.historyEmpty,
			});
			return;
		}
		for (const v of this.versions) {
			const item = this.listEl.createDiv({
				cls: `nhs-history-item${this.selected === v ? " is-selected" : ""}`,
			});
			const meta = item.createDiv({ cls: "nhs-history-item-meta" });
			meta.createSpan({
				cls: "nhs-history-item-time",
				text: formatTime(v.caption.t),
			});
			meta.createSpan({
				cls: "nhs-history-item-device",
				text: v.caption.d,
			});
			meta.createSpan({
				cls: "nhs-history-item-size",
				text: formatSize(v.caption.z),
			});
			const badge = reasonText(v.caption.r);
			if (badge && v.caption.r !== "push") {
				meta.createSpan({
					cls: `nhs-history-badge is-${v.caption.r}`,
					text: badge,
				});
			}
			if (v.caption.p !== this.path) {
				item.createDiv({
					cls: "nhs-history-item-path",
					text: v.caption.p,
				});
			}
			item.addEventListener("click", () => void this.select(v));
		}
		if (this.hasMore) {
			const more = this.listEl.createDiv({
				cls: "nhs-history-load-more",
			});
			const button = new ButtonComponent(more)
				.setButtonText(s.historyLoadMore)
				.onClick((evt) => {
					(evt.currentTarget as HTMLElement).setAttribute(
						"disabled",
						"",
					);
					button.setButtonText("…");
					void this.loadVersions(false);
				});
		}
	}

	// ---- preview ----

	private async select(v: VersionInfo): Promise<void> {
		if (this.restoring) return;
		const generation = ++this.generation;
		this.disposeMarkdown();
		this.selected = v;
		this.selectedContent = null;
		this.selectedText = null;
		this.selectedBinary = false;
		this.showDiff = false;
		const s = getStrings();
		if (Platform.isMobile) {
			this.mountMobileDetail();
		} else {
			this.renderList();
			this.renderPreviewHead(v);
		}
		this.renderLoading(this.previewBodyEl, s.historyLoading);
		try {
			const content = await downloadVersion(this.deps.client, v);
			if (!this.isCurrent(v, generation)) return;
			this.selectedContent = content;
			this.selectedBinary = isBinaryContent(content);
			if (!this.selectedBinary) {
				this.selectedText = new TextDecoder().decode(content);
			}
		} catch (err) {
			if (!this.isCurrent(v, generation)) return;
			this.previewBodyEl.empty();
			this.previewBodyEl.createDiv({
				cls: "nhs-history-message is-error",
				text: s.historyVersionLoadFailed(
					err instanceof Error ? err.message : String(err),
				),
			});
			return;
		}
		if (!this.isCurrent(v, generation)) return;
		if (Platform.isMobile) this.renderPreviewHead(v);
		this.renderActions(v);
		await this.renderPreview();
	}

	private isCurrent(v: VersionInfo, generation: number): boolean {
		return (
			!this.closed && this.selected === v && this.generation === generation
		);
	}

	private renderPreviewHead(v: VersionInfo): void {
		this.previewHeadEl.empty();
		this.previewHeadEl.createSpan({ text: formatTime(v.caption.t) });
		this.previewHeadEl.createSpan({ text: v.caption.d });
		this.previewHeadEl.createSpan({ text: formatSize(v.caption.z) });
		const badge = reasonText(v.caption.r);
		if (badge) {
			this.previewHeadEl.createSpan({
				cls: "nhs-history-badge",
				text: badge,
			});
		}
	}

	private renderActions(v: VersionInfo): void {
		const s = getStrings();
		this.actionRowEl.empty();
		const diffSetting = this.actionRowEl.createDiv({
			cls: "nhs-history-diff-setting",
		});
		diffSetting.createSpan({ text: s.historyDiff });
		new ToggleComponent(diffSetting)
			.setValue(this.showDiff)
			.setDisabled(this.selectedText === null)
			.onChange((value) => {
				this.showDiff = value;
				void this.renderPreview();
			});
		new ButtonComponent(this.actionRowEl)
			.setButtonText(s.historyCopy)
			.setDisabled(this.selectedText === null)
			.onClick(() => {
				if (this.selectedText === null) return;
				void navigator.clipboard
					.writeText(this.selectedText)
					.then(() => new Notice(s.historyCopied));
			});
		new ButtonComponent(this.actionRowEl)
			.setButtonText(s.historyRestore)
			.setDisabled(this.selectedContent === null)
			.onClick(() => this.renderRestoreConfirm(v));
	}

	private renderRestoreConfirm(v: VersionInfo): void {
		const s = getStrings();
		this.actionRowEl.empty();
		this.actionRowEl.createDiv({
			cls: "nhs-history-confirm-text",
			text: s.historyRestoreConfirm(this.path),
		});
		new ButtonComponent(this.actionRowEl)
			.setButtonText(s.historyRestoreConfirmButton)
			.setDestructive()
			.setCta()
			.onClick(() => void this.restore(v));
		new ButtonComponent(this.actionRowEl)
			.setButtonText(s.historyRestoreCancel)
			.onClick(() => this.renderActions(v));
	}

	private async renderPreview(): Promise<void> {
		const v = this.selected;
		if (!v || this.selectedContent === null) return;
		const s = getStrings();
		this.disposeMarkdown();
		this.previewBodyEl.empty();
		if (this.selectedBinary || this.selectedText === null) {
			this.previewBodyEl.createDiv({
				cls: "nhs-history-message",
				text: s.historyBinary,
			});
			return;
		}
		if (!this.showDiff) {
			const target = createDiv({
				cls: "markdown-preview-sizer markdown-preview-section",
			});
			const component = new Component();
			component.load();
			try {
				await MarkdownRenderer.render(
					this.app,
					this.selectedText,
					target,
					this.path,
					component,
				);
			} catch {
				component.unload();
				return;
			}
			if (this.closed || this.selected !== v || this.showDiff) {
				component.unload();
				return;
			}
			this.markdownComponent = component;
			this.previewBodyEl.appendChild(target);
			return;
		}
		let current = "";
		if (await this.deps.vault.exists(this.path)) {
			try {
				const buf = new Uint8Array(
					await this.deps.vault.readBinary(this.path),
				);
				if (!isBinaryContent(buf)) {
					current = new TextDecoder().decode(buf);
				}
			} catch {
				// unreadable current file → diff against empty
			}
		}
		renderDiff(this.previewBodyEl, diffTexts(this.selectedText, current));
	}

	private disposeMarkdown(): void {
		this.markdownComponent?.unload();
		this.markdownComponent = null;
	}

	private renderLoading(container: HTMLElement, text: string): void {
		container.empty();
		container.createDiv({
			cls: "nhs-history-message",
			text,
		});
	}

	// ---- restore ----

	private async restore(v: VersionInfo): Promise<void> {
		const s = getStrings();
		const content = this.selectedContent;
		if (!content || this.restoring) return;
		this.restoring = true;
		this.actionRowEl.empty();
		try {
			// snapshot current local content first (if it differs)
			if (await this.deps.vault.exists(this.path)) {
				const current = new Uint8Array(
					await this.deps.vault.readBinary(this.path),
				);
				if ((await sha256Hex(current)) !== (await sha256Hex(content))) {
					await recordVersion(
						this.deps,
						this.pageId,
						this.path,
						current,
						"restore",
					);
				}
			}
			const dir = parentDir(this.path);
			if (dir !== "") await this.deps.vault.mkdirp(dir);
			await this.deps.vault.writeBinary(
				this.path,
				content.buffer as ArrayBuffer,
			);
			await this.deps.saveState();
			new Notice(s.historyRestored);
			this.close();
		} catch (err) {
			this.restoring = false;
			new Notice(
				s.historyVersionLoadFailed(
					err instanceof Error ? err.message : String(err),
				),
			);
			this.renderActions(v);
		}
	}
}

function renderDiff(container: HTMLElement, lines: DiffLine[]): void {
	const box = container.createDiv({ cls: "nhs-diff" });
	for (const line of lines) {
		const row = box.createDiv({
			cls: `nhs-diff-line${line.type === "add" ? " is-add" : line.type === "del" ? " is-del" : ""}`,
		});
		row.createSpan({
			cls: "nhs-diff-gutter",
			text: line.type === "add" ? "+" : line.type === "del" ? "−" : "",
		});
		if (line.type === "same") {
			row.createSpan({ text: line.text });
		} else if (line.text === "") {
			row.createSpan({ text: "±" });
		} else if (line.changes) {
			for (const c of line.changes) {
				const span = row.createSpan({ text: c.value });
				if (c.added) span.addClass("nhs-diff-inner", "is-add");
				else if (c.removed) span.addClass("nhs-diff-inner", "is-del");
			}
		} else {
			row.createSpan({ text: line.text });
		}
	}
}
