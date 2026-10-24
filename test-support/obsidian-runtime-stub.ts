export class Notice {
	constructor(_message?: string) {}
}

/** Obsidian ≥ 1.8.7 exposes the configured app language; tests default
 * to English and may override via `setStubLanguage`. */
let stubLanguage = "en";

export function setStubLanguage(language: string): void {
	stubLanguage = language;
}

export function getLanguage(): string {
	return stubLanguage;
}

export const moment = {
	locale(): string {
		return stubLanguage;
	},
};

export function requestUrl(): Promise<never> {
	return Promise.reject(new Error("requestUrl is not implemented in tests"));
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
	let s = "";
	const bytes = new Uint8Array(buffer);
	for (const b of bytes) {
		s += String.fromCharCode(b);
	}
	return btoa(s);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const s = atob(base64);
	const out = new Uint8Array(s.length);
	for (let i = 0; i < s.length; i++) {
		out[i] = s.charCodeAt(i);
	}
	return out.buffer;
}

export class Plugin {
	app: unknown;

	constructor(app?: unknown) {
		this.app = app;
	}

	addCommand(): void {}

	addSettingTab(): void {}

	loadData(): Promise<unknown> {
		return Promise.resolve(undefined);
	}

	registerEvent(): void {}

	registerInterval(): void {}

	saveData(): Promise<void> {
		return Promise.resolve();
	}
}

export class PluginSettingTab {
	app: unknown;
	containerEl = { empty() {} } as unknown as HTMLElement;

	constructor(app: unknown, _plugin?: unknown) {
		this.app = app;
	}

	display(): void {}
}

export class Setting {
	constructor(_containerEl: HTMLElement) {}

	addButton(): this {
		return this;
	}

	addDropdown(): this {
		return this;
	}

	addText(): this {
		return this;
	}

	addToggle(): this {
		return this;
	}

	setDesc(): this {
		return this;
	}

	setName(): this {
		return this;
	}
}

export class TFile {
	path = "";
	extension = "md";
	stat = { size: 0, mtime: 0 };
}

export class MarkdownView {
	file: { path: string } | null = null;
	editor = {
		getValue: (): string => "",
		setValue: (_text: string): void => {},
		getCursor: (): { line: number; ch: number } => ({ line: 0, ch: 0 }),
		setCursor: (_pos: { line: number; ch: number }): void => {},
		lineCount: (): number => 0,
		getLine: (_line: number): string => "",
	};
}
