// Settings-panel building blocks — the look, kept apart from
// settings-tab.ts so that file stays a readable list of *what* the settings
// are. Three primitives: a section heading, a row of toggle chips, and a
// number field with the unit beside it.

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

// ── number field ───────────────────────────────────────────
// A slider was the wrong tool here: these ranges are wide (0–1440 minutes)
// and the useful values are specific (5, 10, 30) — dragging one notch jumps
// by dozens and landing on the number you want is luck. A small text box
// with the unit beside it says exactly what it holds, and typing is exact.
//
// The box is deliberately forgiving: it does not reformat while you type
// (typing "1", "0" toward "10" must not become "1" then "10" snapped back to
// 1), and it commits on blur/Enter, so a half-typed number is never saved.

/** Snap to the step grid and stay inside the limits.
 *
 * A persisted value can sit outside the range we now offer (older data.json,
 * a hand edit). Clamping on the way in keeps the field and the stored value
 * from disagreeing. Pure, so the rule is testable. */
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

/** What a typed string means as a number, or null if it means nothing.
 *
 * `Number("")` is 0 and `Number(" ")` is 0, which would silently turn an
 * emptied field into "off". An empty box is not a zero — it is "no answer",
 * and the caller restores the previous value instead. */
export function parseNumberInput(raw: string): number | null {
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const n = Number(trimmed);
	return Number.isFinite(n) ? n : null;
}

/** Hover text stating the accepted range — the one thing a text box cannot
 * show by itself and a slider showed for free. */
export function rangeHint(min: number, max: number, unit: string): string {
	const span = `${min}–${max}`;
	return unit ? `${span} ${unit}` : span;
}

export interface NumberFieldOptions {
	min: number;
	max: number;
	step: number;
	value: number;
	/** Shown after the box ("分钟", "MB"); empty renders nothing. */
	unit: string;
	/** Accessible name for the input. */
	ariaLabel?: string;
	onInput: (n: number) => void;
	/** Persist. Called once per committed edit, not per keystroke. */
	save: () => void | Promise<void>;
}

export function addNumberField(s: Setting, o: NumberFieldOptions): void {
	const initial = clampToStep(o.value, o.min, o.max, o.step);
	let current = initial;

	s.addText((text) => {
		const el = text.inputEl;
		// text + inputMode, not type=number: the native spinner sits on top of
		// the unit label and a stray scroll wheel edits a setting.
		el.type = "text";
		el.inputMode = "numeric";
		el.addClass("nhs-number-input");
		el.setAttribute("aria-label", o.ariaLabel ?? "");
		el.setAttribute("title", rangeHint(o.min, o.max, o.unit));
		el.value = String(initial);

		const commit = (): void => {
			const parsed = parseNumberInput(el.value);
			// Empty or nonsense: put the last good number back, save nothing.
			const next =
				parsed === null
					? current
					: clampToStep(parsed, o.min, o.max, o.step);
			el.value = String(next);
			if (next === current) return;
			current = next;
			o.onInput(next);
			void o.save();
		};

		el.addEventListener("blur", commit);
		el.addEventListener("keydown", (ev) => {
			if (ev.key !== "Enter") return;
			ev.preventDefault();
			commit();
			el.blur();
		});
	});

	if (o.unit) {
		s.controlEl.createSpan({ cls: "nhs-unit", text: o.unit });
	}

	// A stored value outside the current range would otherwise sit in memory
	// at the old number while the box shows the clamped one. Correct it once,
	// without saving: opening a settings tab should not write data.json.
	if (initial !== o.value) o.onInput(initial);
}
