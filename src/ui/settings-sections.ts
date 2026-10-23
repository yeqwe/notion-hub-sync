// A row of toggle chips for a group of related on/off switches.
//
// Five file-type switches and eight .obsidian-category switches used to be
// thirteen full setting rows — one decision each, so the user scrolls past
// most of them. The data and the persistence are unchanged; only the layout
// collapses: one chip per option, click to flip, plus a bulk button for
// "all of them".
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
