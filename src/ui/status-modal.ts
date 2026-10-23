// Sync status modal: last sync time, last round counts, failures/warnings,
// and conflict copies currently in the vault (each with Open / Delete) —
// plus "Sync now" / "Full sync" buttons. Mobile-friendly single column.

import { App, ButtonComponent, Modal, Platform, TFile } from "obsidian";

import { blockedLabels, getStrings } from "../i18n";
import type { SyncState } from "../sync/state";
import { summarizeBlocked } from "../sync/blocked";
import { CONFLICT_COPY_RE } from "../sync/paths";

export interface StatusModalDeps {
	app: App;
	state: SyncState | null;
	onSyncNow(): void;
	onFullSync(): void;
}

export function openStatusModal(deps: StatusModalDeps): void {
	new StatusModal(deps).open();
}

/** Vault paths matching our conflict-copy naming (shared matcher). */
export function findConflictCopies(app: App): TFile[] {
	return app.vault.getFiles().filter((f) => CONFLICT_COPY_RE.test(f.path));
}

/** "a/b/x (conflict dev 2026-…).md" → "a/b/x.md". */
function originalPath(copyPath: string): string {
	return copyPath.replace(CONFLICT_COPY_RE, "");
}

class StatusModal extends Modal {
	constructor(private readonly deps: StatusModalDeps) {
		super(deps.app);
		this.modalEl.classList.add("nhs-status-modal");
		if (Platform.isMobile) this.modalEl.classList.add("is-mobile");
	}

	onOpen(): void {
		const s = getStrings();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: s.statusTitle });

		const st = this.deps.state;
		const last = st?.lastSyncAt
			? new Date(st.lastSyncAt).toLocaleString()
			: s.statusNever;
		contentEl.createEl("div", {
			cls: "nhs-status-line",
			text: s.statusLastSync(last),
		});

		const r = st?.lastReport;
		if (r) {
			contentEl.createEl("div", {
				cls: "nhs-status-line",
				text: s.syncDone(r.created, r.updated, r.skipped, r.failed),
			});
			if (r.failures.length > 0) {
				contentEl.createEl("div", {
					cls: "nhs-status-head",
					text: s.statusFailures,
				});
				const ul = contentEl.createEl("ul", { cls: "nhs-status-list" });
				for (const f of r.failures) ul.createEl("li", { text: f });
			}
			if (r.warnings.length > 0) {
				contentEl.createEl("div", {
					cls: "nhs-status-head",
					text: s.statusWarnings,
				});
				const ul = contentEl.createEl("ul", { cls: "nhs-status-list" });
				for (const w of r.warnings) ul.createEl("li", { text: w });
			}
		}

		// files that did not sync — previously invisible anywhere in the UI
		const blocked = this.deps.state?.lastReport?.blocked ?? [];
		if (blocked.length > 0) {
			const sum = summarizeBlocked(blocked, blockedLabels(s));
			contentEl.createEl("div", {
				cls: "nhs-status-head",
				text: sum.headline,
			});
			const list = contentEl.createEl("ul", { cls: "nhs-status-list" });
			for (const f of sum.files.slice(0, 20)) {
				const li = list.createEl("li");
				li.createSpan({ text: f.path });
				li.createSpan({
					cls: "nhs-status-blocked-reason",
					text: `（${f.label}${f.detail ? `: ${f.detail}` : ""}）`,
				});
			}
			if (sum.files.length > 20) {
				list.createEl("li", {
					text: `…+${sum.files.length - 20}`,
				});
			}
			contentEl.createEl("div", {
				cls: "nhs-status-line",
				text: s.blockedOthersUnaffected,
			});
		}

		// conflict copies in the vault
		const copies = findConflictCopies(this.deps.app);
		contentEl.createEl("div", {
			cls: "nhs-status-head",
			text:
				copies.length > 0
					? s.statusConflicts(copies.length)
					: s.statusNoConflicts,
		});
		for (const f of copies) {
			const row = contentEl.createEl("div", { cls: "nhs-status-conflict" });
			row.createEl("div", {
				cls: "nhs-status-conflict-path",
				text: f.path,
			});
			row.createEl("div", {
				cls: "nhs-status-conflict-orig",
				text: `→ ${originalPath(f.path)}`,
			});
			const buttons = row.createEl("div", {
				cls: "nhs-status-conflict-actions",
			});
			new ButtonComponent(buttons)
				.setButtonText(s.statusOpen)
				.onClick(() => {
					void this.app.workspace.openLinkText(f.path, "", false);
				});
			new ButtonComponent(buttons)
				.setButtonText(s.statusDelete)
				.setWarning()
				.onClick(async () => {
					await this.app.fileManager.trashFile(f);
					row.empty();
					row.setText(s.statusDeleted);
				});
		}

		const actions = contentEl.createEl("div", {
			cls: "nhs-status-actions",
		});
		new ButtonComponent(actions)
			.setButtonText(s.commandSyncNow)
			.setCta()
			.onClick(() => {
				this.close();
				this.deps.onSyncNow();
			});
		new ButtonComponent(actions)
			.setButtonText(s.commandFullSync)
			.onClick(() => {
				this.close();
				this.deps.onFullSync();
			});
	}
}
