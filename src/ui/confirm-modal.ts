// Small generic confirmation modal: title + text + Proceed/Cancel.
// Resolves false unless the user explicitly confirms.

import { App, ButtonComponent, Modal, Platform } from "obsidian";

import { getStrings } from "../i18n";

export function confirmAction(
	app: App,
	opts: { title: string; text: string; warning?: boolean },
): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmModal(app, opts, resolve).open();
	});
}

class ConfirmModal extends Modal {
	private resolved = false;

	constructor(
		app: App,
		private readonly opts: {
			title: string;
			text: string;
			warning?: boolean;
		},
		private readonly resolve: (ok: boolean) => void,
	) {
		super(app);
		this.modalEl.classList.add("nhs-confirm-modal");
		if (Platform.isMobile) this.modalEl.classList.add("is-mobile");
	}

	onOpen(): void {
		const s = getStrings();
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: this.opts.title });
		contentEl.createEl("p", {
			cls: this.opts.warning ? "nhs-confirm-warning" : undefined,
			text: this.opts.text,
		});
		const row = contentEl.createDiv({ cls: "nhs-confirm-buttons" });
		const proceed = new ButtonComponent(row).setButtonText(
			s.confirmProceed,
		);
		if (this.opts.warning) proceed.setWarning();
		proceed.onClick(() => this.done(true));
		new ButtonComponent(row)
			.setButtonText(s.confirmCancel)
			.onClick(() => this.done(false));
	}

	onClose(): void {
		this.contentEl.empty();
		this.done(false);
	}

	private done(ok: boolean): void {
		if (this.resolved) return;
		this.resolved = true;
		this.close();
		this.resolve(ok);
	}
}
