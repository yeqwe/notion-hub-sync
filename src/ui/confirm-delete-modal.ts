// Bulk local-delete guard modal: lists the files Notion deleted and asks
// whether to delete them locally, keep + re-upload, or cancel the round.
// Closing the modal any other way counts as cancel.

import { App, ButtonComponent, Modal, Platform } from "obsidian";

import { getStrings } from "../i18n";

export type DeleteGuardChoice = "delete" | "keep" | "cancel";

const MAX_LISTED = 100;

export function confirmLocalDeletes(
	app: App,
	paths: string[],
): Promise<DeleteGuardChoice> {
	return new Promise((resolve) => {
		new ConfirmDeleteModal(app, paths, resolve).open();
	});
}

class ConfirmDeleteModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly paths: string[],
		private readonly resolve: (choice: DeleteGuardChoice) => void,
	) {
		super(app);
		this.modalEl.classList.add("nhs-confirm-modal");
		if (Platform.isMobile) this.modalEl.classList.add("is-mobile");
	}

	onOpen(): void {
		const s = getStrings();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: s.deleteGuardTitle });
		contentEl.createEl("p", { text: s.deleteGuardText(this.paths.length) });
		const list = contentEl.createDiv({ cls: "nhs-confirm-delete-list" });
		for (const p of this.paths.slice(0, MAX_LISTED)) {
			list.createDiv({ cls: "nhs-confirm-delete-item", text: p });
		}
		if (this.paths.length > MAX_LISTED) {
			list.createDiv({
				cls: "nhs-confirm-delete-item",
				text: s.deleteGuardMore(this.paths.length - MAX_LISTED),
			});
		}
		const row = contentEl.createDiv({ cls: "nhs-confirm-buttons" });
		new ButtonComponent(row)
			.setButtonText(s.deleteGuardDelete)
			.setWarning()
			.onClick(() => this.done("delete"));
		new ButtonComponent(row)
			.setButtonText(s.deleteGuardKeep)
			.setCta()
			.onClick(() => this.done("keep"));
		new ButtonComponent(row)
			.setButtonText(s.deleteGuardCancel)
			.onClick(() => this.done("cancel"));
	}

	onClose(): void {
		this.contentEl.empty();
		this.done("cancel");
	}

	private done(choice: DeleteGuardChoice): void {
		if (this.resolved) return;
		this.resolved = true;
		this.close();
		this.resolve(choice);
	}
}
