// Settings-panel building blocks — the look, kept apart from
// settings-tab.ts so that file stays a readable list of *what* the settings
// are. Three primitives: a section heading, a row of toggle chips, and a
// number slider with a live readout.

import type { Setting } from "obsidian";

// ── section heading ──────────────────────────────────────────
// Obsidian's own settings use an <h2> for a section; the separator line and
// the "first one sits flush" rule live in CSS so this stays one line.
export function addSection(el: HTMLElement, title: string): void {
	el.createEl("h2", { cls: "nhs-settings-section", text: title });
}

// ── multi-select chips ───────────────────────────────────────
// Five file-type switches and eight .obsidian-category switches used to be
// thirteen full setting rows — one decision each, so the user scrolls past
// most of them. The data and the persistence are unchanged; only the layout
// collapses: one chip per option, click to flip, plus a bulk button.
//
// Chips are real <button>s carrying aria-pressed, so the state is announced
// by a screen reader and reachable from the keyboard — a div with a click
// handler would look the same and be invisible to both.

export interface MultiSelectOption {
	key: string;
	label: string;
	/** Tooltip for an option whose meaning needs a sentence ("Other files"). */
	title?: string;
}

export interface MultiSelectState {
	isOn(key: string): boolean;
	/** Flip in memory. `commit` persists — one write per click, not per chip. */
	set(key: string, on: boolean): void;
	commit?(): void | Promise<void>;
}

export interface MultiSelectLabels {
	/** Shown while something is off — clicking turns everything on. */
	selectAll: string;
	/** Shown once everything is on — clicking turns everything off. */
	selectNone: string;
}

/** The bulk button's next value: "any option off" means turn them all on.
 * Extracted so the direction is one testable rule instead of a ternary
 * buried in a click handler. */
export function bulkTargetValue(states: readonly boolean[]): boolean {
	return states.some((on) => !on);
}

export function addMultiSelect(
	el: HTMLElement,
	options: readonly MultiSelectOption[],
	state: MultiSelectState,
	labels: MultiSelectLabels,
): void {
	if (options.length === 0) return;
	const row = el.createDiv({ cls: "nhs-multiselect" });
	const chips = new Map<string, HTMLButtonElement>();
	const keys = options.map((o) => o.key);

	// The whole row commits once: a bulk click that saved per chip would
	// write data.json thirteen times for one decision.
	const apply = (changes: Array<[string, boolean]>): void => {
		for (const [key, on] of changes) state.set(key, on);
		void Promise.resolve(state.commit?.()).then(paint);
	};

	for (const opt of options) {
		const chip = row.createEl("button", {
			cls: "nhs-chip",
			text: opt.label,
		});
		if (opt.title) chip.setAttribute("title", opt.title);
		chip.addEventListener("click", () =>
			apply([[opt.key, !state.isOn(opt.key)]]),
		);
		chips.set(opt.key, chip);
	}

	const bulk = row.createEl("button", { cls: "nhs-chip nhs-chip-bulk" });
	bulk.addEventListener("click", () => {
		const turnOn = bulkTargetValue(keys.map((k) => state.isOn(k)));
		apply(
			keys
				.filter((k) => state.isOn(k) !== turnOn)
				.map((k) => [k, turnOn] as [string, boolean]),
		);
	});

	function paint(): void {
		const states: boolean[] = [];
		for (const [key, chip] of chips) {
			const on = state.isOn(key);
			states.push(on);
			chip.toggleClass("is-on", on);
			chip.setAttribute("aria-pressed", String(on));
		}
		const label = bulkTargetValue(states)
			? labels.selectAll
			: labels.selectNone;
		bulk.setText(label);
		bulk.setAttribute("aria-label", label);
	}

	paint();
}

// ── number slider ───────────────────────────────────────────
// A text field for "sync every N minutes" makes the user type a number and
// then tells them nothing about the sane range. A slider shows the range and
// the current value at once, and the unit moves out of the label into the
// readout ("10 分钟"), so the name stays short.

/** Snap to the step grid and stay inside the limits.
 *
 * A persisted value can sit outside the range we now offer (older data.json,
 * a hand edit). A slider handed such a value either throws or renders in the
 * wrong place, so it is clamped on the way in. Pure, so the rule is testable. */
export function clampToStep(
	value: number,
	min: number,
	max: number,
	step: number,
): number {
	if (Number.isNaN(value)) return min;
	// Infinity needs no special case: Math.min/max clamp it to the limits.
	const clamped = Math.min(max, Math.max(min, value));
	if (!(step > 0)) return clamped;
	const snapped = min + Math.round((clamped - min) / step) * step;
	return Math.min(max, Math.max(min, snapped));
}

/** `10` + `分钟` → `10 分钟`; an empty unit gives a bare number. */
export function withUnit(n: number, unit: string): string {
	return unit ? `${n} ${unit}` : String(n);
}

/** The readout text. `offAtZero` exists because several of these sliders use
 * 0 as "disabled" (sync interval, retention guard) and "0 分钟" reads like a
 * broken setting rather than an intentional off switch. */
export function sliderReadout(
	n: number,
	unit: string,
	offAtZero?: string,
): string {
	if (n === 0 && offAtZero) return offAtZero;
	return withUnit(n, unit);
}

export interface NumberSliderOptions {
	min: number;
	max: number;
	step: number;
	value: number;
	/** Readout text — the unit lives here, not in the setting name. */
	format: (n: number) => string;
	onInput: (n: number) => void;
	/** Persist. Debounced, so one drag writes data.json once. */
	save: () => void | Promise<void>;
	/** Accessible name for the bare range input. */
	ariaLabel?: string;
}

const SAVE_DEBOUNCE_MS = 400;

export function addNumberSlider(s: Setting, o: NumberSliderOptions): void {
	let value = clampToStep(o.value, o.min, o.max, o.step);
	// A stored value outside the range we now offer would otherwise sit in
	// memory at the old number while the track shows the clamped one — the
	// user would never learn their 2000 MB became 1000. Correct it once, here,
	// without saving: opening a settings tab should not write data.json, and
	// the next real edit persists the corrected value anyway.
	if (value !== o.value) o.onInput(value);
	let timer: number | null = null;
	const scheduleSave = (): void => {
		if (timer !== null) window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			timer = null;
			void o.save();
		}, SAVE_DEBOUNCE_MS);
	};

	// A native range input carrying Obsidian's own `slider` class, rather than
	// Setting.addSlider(): from 1.6 on, SliderComponent renders its own
	// numeric readout next to the track, which would show "10" beside our
	// "10 分钟". Owning the element means exactly one number on the row, and
	// the `slider` class still picks up the theme's track and thumb.
	const input = s.controlEl.createEl("input", {
		cls: "slider",
		type: "range",
	});
	input.min = String(o.min);
	input.max = String(o.max);
	input.step = String(o.step);
	input.value = String(value);
	input.setAttribute("aria-label", o.ariaLabel ?? "");

	const readout = s.controlEl.createSpan({
		cls: "nhs-slider-value",
		text: o.format(value),
	});

	input.addEventListener("input", () => {
		value = clampToStep(input.valueAsNumber, o.min, o.max, o.step);
		readout.setText(o.format(value));
		o.onInput(value);
		scheduleSave();
	});
}
