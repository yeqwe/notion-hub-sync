// Three-way line merge (Base / Local / Remote), pure function, no I/O.
// Ported from pickpen's merge3.ts — git merge-file / GNU diff3 semantics:
// - adjacent (touching) unstable regions from both sides merge into one
//   conflict region: two changes are only independent if an unchanged line
//   separates them;
// - both sides making the identical change is NOT a conflict (git behavior);
// - pure insertions are zero-width regions: different inserts at the same
//   anchor on both sides → conflict.
// On conflict only the region count is reported — no <<<<<<< markers; the
// caller falls back to a conflict copy (both full files preserved).
// Lines are split keeping their own EOL (splitKeepingEol): join("") is a
// byte-exact restore, no CRLF normalization, and a clean merge never alters
// unchanged lines' bytes.

import { diffArrays } from "diff";

export interface MergeOutcome {
	/** No conflicts: text holds the merged result. */
	clean: boolean;
	/** Merged text (byte-level, original EOLs) when clean. */
	text?: string;
	/** Conflict region count (logging only; callers need clean). */
	conflictCount: number;
}

/** Each line keeps its own trailing newline; join("") restores the text. */
function splitKeepingEol(text: string): string[] {
	if (text === "") return [];
	return text.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

/** One change of side vs base: base[baseStart,baseEnd) ↔ side[sideStart,sideEnd). */
interface Region {
	baseStart: number;
	baseEnd: number;
	sideStart: number;
	sideEnd: number;
}

/**
 * Change regions of side vs base, sorted by baseStart, non-overlapping.
 * jsdiff always emits removed blocks before added ones; a lone removed is a
 * zero-width side span (pure delete), a lone added a zero-width base span.
 */
function changeRegions(base: string[], side: string[]): Region[] {
	const regions: Region[] = [];
	let basePos = 0;
	let sidePos = 0;
	// dangling removed: waits for a following added to pair with; if none
	// comes it lands as a pure deletion at the end of a common block
	let pendingRemoved: { start: number; end: number } | null = null;
	for (const block of diffArrays(base, side)) {
		const n = block.value.length;
		if (block.removed) {
			pendingRemoved = { start: basePos, end: basePos + n };
			basePos += n;
			continue;
		}
		if (block.added) {
			const start = pendingRemoved ? pendingRemoved.start : basePos;
			regions.push({
				baseStart: start,
				baseEnd: basePos,
				sideStart: sidePos,
				sideEnd: sidePos + n,
			});
			pendingRemoved = null;
			sidePos += n;
			continue;
		}
		if (pendingRemoved) {
			regions.push({
				baseStart: pendingRemoved.start,
				baseEnd: pendingRemoved.end,
				sideStart: sidePos,
				sideEnd: sidePos,
			});
			pendingRemoved = null;
		}
		basePos += n;
		sidePos += n;
	}
	if (pendingRemoved) {
		regions.push({
			baseStart: pendingRemoved.start,
			baseEnd: pendingRemoved.end,
			sideStart: sidePos,
			sideEnd: sidePos,
		});
	}
	return regions;
}

/**
 * One side's text over the conflict zone [start,end): unchanged gaps come
 * from base lines (identical on both sides), changed spans from the side.
 */
function chunkText(
	base: string[],
	side: string[],
	chunk: Region[],
	start: number,
	end: number,
): string[] {
	const out: string[] = [];
	let cursor = start;
	for (const r of chunk) {
		out.push(...base.slice(cursor, r.baseStart));
		out.push(...side.slice(r.sideStart, r.sideEnd));
		cursor = r.baseEnd;
	}
	out.push(...base.slice(cursor, end));
	return out;
}

function linesEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/**
 * Three-way merge. base = common ancestor, ours = local, theirs = remote.
 * Fast paths: either side byte-identical to base → take the other; both
 * identical → take that (also avoids diffing huge files needlessly).
 */
export function merge3Text(
	base: string,
	ours: string,
	theirs: string,
): MergeOutcome {
	if (ours === theirs) return { clean: true, text: ours, conflictCount: 0 };
	if (base === ours) return { clean: true, text: theirs, conflictCount: 0 };
	if (base === theirs) return { clean: true, text: ours, conflictCount: 0 };

	const baseLines = splitKeepingEol(base);
	const ourLines = splitKeepingEol(ours);
	const theirLines = splitKeepingEol(theirs);
	const ourRegions = changeRegions(baseLines, ourLines);
	const theirRegions = changeRegions(baseLines, theirLines);

	const out: string[] = [];
	let conflicts = 0;
	let i = 0;
	let j = 0;
	let pos = 0;

	while (i < ourRegions.length || j < theirRegions.length) {
		const o = ourRegions[i];
		const t = theirRegions[j];
		const start = Math.min(
			o ? o.baseStart : Infinity,
			t ? t.baseStart : Infinity,
		);
		if (start === Infinity) break;
		out.push(...baseLines.slice(pos, start));

		// absorb all overlapping/touching regions from both sides
		let end = start;
		const ourChunk: Region[] = [];
		const theirChunk: Region[] = [];
		for (;;) {
			let grew = false;
			while (i < ourRegions.length && ourRegions[i]!.baseStart <= end) {
				end = Math.max(end, ourRegions[i]!.baseEnd);
				ourChunk.push(ourRegions[i]!);
				i += 1;
				grew = true;
			}
			while (
				j < theirRegions.length &&
				theirRegions[j]!.baseStart <= end
			) {
				end = Math.max(end, theirRegions[j]!.baseEnd);
				theirChunk.push(theirRegions[j]!);
				j += 1;
				grew = true;
			}
			if (!grew) break;
		}

		const baseText = baseLines.slice(start, end);
		const ourText = chunkText(baseLines, ourLines, ourChunk, start, end);
		const theirText = chunkText(
			baseLines,
			theirLines,
			theirChunk,
			start,
			end,
		);

		if (linesEqual(ourText, theirText)) {
			out.push(...ourText);
		} else if (linesEqual(ourText, baseText)) {
			out.push(...theirText);
		} else if (linesEqual(theirText, baseText)) {
			out.push(...ourText);
		} else {
			conflicts += 1;
		}
		pos = end;
	}
	out.push(...baseLines.slice(pos));

	if (conflicts > 0) return { clean: false, conflictCount: conflicts };
	return { clean: true, text: out.join(""), conflictCount: 0 };
}
