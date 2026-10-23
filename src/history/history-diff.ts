// Line-level + intra-line diff for version history. Ported from pickpen's
// history-diff.ts nearly verbatim: semantics = history version (old) →
// current file (new); del = old-only lines, add = new lines.

import { diffArrays, diffWordsWithSpace } from "diff";

export interface DiffChange {
	added?: boolean;
	removed?: boolean;
	value: string;
}

export interface DiffLine {
	type: "add" | "del" | "same";
	text: string;
	changes?: DiffChange[];
}

// Split on \n, strip CR (CRLF files), no trailing empty line.
function toLines(text: string): string[] {
	const lines = text
		.split("\n")
		.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

// Pair two changed lines → intra-line segments (removed line keeps removed
// segments, added line keeps added segments, same segments keep order).
function wordChanges(
	oldLine: string,
	newLine: string,
	kind: "del" | "add",
): DiffChange[] {
	return diffWordsWithSpace(oldLine, newLine)
		.filter((p) => (kind === "del" ? !p.added : !p.removed))
		.map((p) =>
			kind === "del"
				? { value: p.value, removed: p.removed || undefined }
				: { value: p.value, added: p.added || undefined },
		);
}

export function diffTexts(oldText: string, newText: string): DiffLine[] {
	const blocks = diffArrays(toLines(oldText), toLines(newText));
	const lines: DiffLine[] = [];
	let removed: string[] = [];
	let added: string[] = [];
	const flush = (): void => {
		const pairs = Math.min(removed.length, added.length);
		for (let i = 0; i < removed.length; i++) {
			lines.push({
				type: "del",
				text: removed[i]!,
				changes:
					i < pairs
						? wordChanges(removed[i]!, added[i]!, "del")
						: undefined,
			});
		}
		for (let i = 0; i < added.length; i++) {
			lines.push({
				type: "add",
				text: added[i]!,
				changes:
					i < pairs
						? wordChanges(removed[i]!, added[i]!, "add")
						: undefined,
			});
		}
		removed = [];
		added = [];
	};
	for (const block of blocks) {
		if (block.added) {
			added.push(...block.value);
		} else if (block.removed) {
			removed.push(...block.value);
		} else {
			flush();
			for (const text of block.value)
				lines.push({ type: "same", text });
		}
	}
	flush();
	return lines;
}
