// Recoverable deleted files: scans history pages under the 🗄️ container;
// a page counts as "deleted" when its title (a file's pageId) has no state
// entry, or the recorded path no longer exists in the vault. Shows the
// newest version's path/time/size; restore writes those bytes back (with a
// pickpen-style conflict-copy name when the path is already taken).

import { App, ButtonComponent, Modal, Notice, Platform } from "obsidian";

import { getStrings } from "../i18n";
import { conflictPath } from "../sync/paths";
import { parentDir } from "../sync/vault-io";
import {
	listHistoryPages,
	listVersions,
	downloadVersion,
	type VersionInfo,
} from "../sync/history";
import type { HistoryUiDeps } from "./history-modal";
import { formatSize, formatTime } from "./history-modal";

const PAGE_BATCH = 20;

interface DeletedItem {
	pageId: string; // history page title = file page hex32
	historyPageId: string;
	version: VersionInfo;
}

export function openDeletedFilesModal(deps: HistoryUiDeps): void {
	new DeletedFilesModal(deps).open();
}

class DeletedFilesModal extends Modal {
	private readonly deps: HistoryUiDeps;

	private items: DeletedItem[] = [];
	private nextCursor: string | null = null;
	private hasMore = false;
	private scanning = false;
	private closed = false;
	private restoring = false;
	private selected: DeletedItem | null = null;
	private selectedContent: Uint8Array | null = null;

	private listEl!: HTMLElement;
	private previewHeadEl!: HTMLElement;
	private actionRowEl!: HTMLElement;
	private previewBodyEl!: HTMLElement;

	constructor(deps: HistoryUiDeps) {
		super(deps.app);
		this.deps = deps;
		this.modalEl.classList.add("nhs-history-modal", "nhs-deleted-modal");
		if (Platform.isMobile) this.modalEl.classList.add("is-mobile");
	}

	async onOpen(): Promise<void> {
		const s = getStrings();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: s.deletedFilesTitle });
		const split = contentEl.createDiv({ cls: "nhs-history-split" });
		const listPane = split.createDiv({ cls: "nhs-history-list-pane" });
		this.listEl = listPane.createDiv({ cls: "nhs-history-list" });
		const previewPane = split.createDiv({ cls: "nhs-history-pane" });
		this.previewHeadEl = previewPane.createDiv({
			cls: "nhs-history-preview-head",
		});
		this.actionRowEl = previewPane.createDiv({
			cls: "nhs-history-actions",
		});
		this.previewBodyEl = previewPane.createDiv({
			cls: "nhs-history-preview",
		});
		await this.loadMore();
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
	}

	/** Fetch the next container page (or up to PAGE_BATCH history pages),
	 * probing each for a newest version; appends deleted entries. */
	private async loadMore(): Promise<void> {
		if (this.scanning || this.closed) return;
		const s = getStrings();
		this.scanning = true;
		this.renderLoading(this.listEl, s.historyLoading);
		try {
			const container = this.deps.state.historyRootId;
			if (!container) {
				this.hasMore = false;
				this.renderList();
				return;
			}
			let scanned = 0;
			// keep going until a page of history pages is consumed or we
			// produced PAGE_BATCH candidates — one page per load-more click
			const res = await listHistoryPages(
				this.deps.client,
				container,
				this.nextCursor ?? undefined,
			);
			if (this.closed) return;
			this.nextCursor = res.nextCursor;
			this.hasMore = res.hasMore;
			for (const page of res.pages) {
				if (scanned >= PAGE_BATCH) break;
				scanned++;
				const deleted = await this.probePage(page.id, page.title);
				if (deleted) this.items.push(deleted);
			}
			// still scanning leftover pages of this batch next click
			this.hasMore = this.hasMore || res.pages.length > scanned;
			this.renderList();
		} catch (err) {
			if (this.closed) return;
			this.listEl.createDiv({
				cls: "nhs-history-message is-error",
				text: err instanceof Error ? err.message : String(err),
			});
		} finally {
			this.scanning = false;
		}
	}

	private async probePage(
		historyPageId: string,
		title: string,
	): Promise<DeletedItem | null> {
		const pageId = title.toLowerCase();
		const entry = this.deps.state.entries[pageId];
		if (entry && (await this.deps.vault.exists(entry.path))) {
			return null; // file still around
		}
		const { versions } = await listVersions(
			this.deps.client,
			historyPageId,
		);
		const newest = versions[0];
		if (!newest) return null;
		return { pageId, historyPageId, version: newest };
	}

	private renderLoading(container: HTMLElement, text: string): void {
		if (this.items.length === 0) {
			container.empty();
			container.createDiv({ cls: "nhs-history-message", text });
		}
	}

	private renderList(): void {
		const s = getStrings();
		this.listEl.empty();
		if (this.items.length === 0) {
			this.listEl.createDiv({
				cls: "nhs-history-message",
				text: s.deletedFilesEmpty,
			});
		}
		for (const item of this.items) {
			const row = this.listEl.createDiv({
				cls: `nhs-history-item${this.selected === item ? " is-selected" : ""}`,
			});
			const meta = row.createDiv({ cls: "nhs-history-item-meta" });
			meta.createSpan({
				cls: "nhs-history-item-time",
				text: formatTime(item.version.caption.t),
			});
			meta.createSpan({
				cls: "nhs-history-item-size",
				text: formatSize(item.version.caption.z),
			});
			row.createDiv({
				cls: "nhs-history-item-path",
				text: item.version.caption.p,
			});
			row.addEventListener("click", () => void this.select(item));
		}
		if (this.hasMore) {
			const more = this.listEl.createDiv({
				cls: "nhs-history-load-more",
			});
			new ButtonComponent(more)
				.setButtonText(s.historyLoadMore)
				.onClick(() => void this.loadMore());
		}
	}

	private async select(item: DeletedItem): Promise<void> {
		if (this.restoring) return;
		const s = getStrings();
		this.selected = item;
		this.selectedContent = null;
		this.renderList();
		this.previewHeadEl.empty();
		this.previewHeadEl.createSpan({
			text: item.version.caption.p,
		});
		this.previewHeadEl.createSpan({
			text: formatTime(item.version.caption.t),
		});
		this.previewBodyEl.empty();
		this.actionRowEl.empty();
		new ButtonComponent(this.actionRowEl)
			.setButtonText(s.deletedFilesRestore)
			.onClick(() => void this.restore(item));
	}

	private async restore(item: DeletedItem): Promise<void> {
		if (this.restoring) return;
		const s = getStrings();
		this.restoring = true;
		try {
			const content =
				this.selectedContent ??
				(await downloadVersion(this.deps.client, item.version));
			let path = item.version.caption.p;
			let taken = false;
			if (await this.deps.vault.exists(path)) {
				path = conflictPath(
					path,
					this.deps.deviceId.slice(0, 8),
					new Date(),
				);
				taken = true;
			}
			const dir = parentDir(path);
			if (dir !== "") await this.deps.vault.mkdirp(dir);
			await this.deps.vault.writeBinary(
				path,
				content.buffer as ArrayBuffer,
			);
			new Notice(
				taken ? s.deletedFilesPathTaken(path) : s.deletedFilesRestored,
			);
			this.items = this.items.filter((x) => x !== item);
			this.renderList();
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
		} finally {
			this.restoring = false;
		}
	}
}
