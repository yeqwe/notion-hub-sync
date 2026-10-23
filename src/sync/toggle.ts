import { arrayBufferToBase64, base64ToArrayBuffer } from "obsidian";
import { sha256Hex } from "./hashes";

export const SOURCE_TOGGLE_MAX_BYTES = 150_000;
const SUMMARY_RE =
	/^🔒 obsidian-source v1 sha256:([0-9a-f]{64})(?: visible:([0-9a-f]{64}))?$/;
export const VIS_PLACEHOLDER = "0".repeat(64);

/** The source `<details>` toggle, or null when bytes are too large. */
export function buildSourceToggle(
	srcSha: string,
	visSha: string,
	bytes: Uint8Array,
): string | null {
	if (bytes.length > SOURCE_TOGGLE_MAX_BYTES) {
		return null;
	}
	const b64 = arrayBufferToBase64(
		bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer,
	);
	const wrapped =
		b64.replace(/(.{76})/g, "$1\n").replace(/\n$/, "");
	return [
		"<details>",
		`<summary>🔒 obsidian-source v1 sha256:${srcSha} visible:${visSha}</summary>`,
		"\t```plain text",
		wrapped,
		"\t```",
		"</details>",
	].join("\n");
}

export function summaryLine(srcSha: string, visSha: string): string {
	return `<summary>🔒 obsidian-source v1 sha256:${srcSha} visible:${visSha}</summary>`;
}

export interface SplitResult {
	visible: string;
	childPageLines: string[];
	source: {
		srcSha: string;
		visSha: string | null;
		bytes: Uint8Array | null; // null when sha does not match
	} | null;
}

/**
 * Split Notion markdown into { visible, childPageLines, source }.
 * `visible` drops the source toggle (wherever it sits) and all top-level
 * `<page …>`/`<database …>` lines (those land in childPageLines).
 */
export async function splitPageMarkdown(md: string): Promise<SplitResult> {
	const lines = md.replace(/\r\n/g, "\n").split("\n");
	const out: string[] = [];
	const childPageLines: string[] = [];
	let source: SplitResult["source"] = null;

	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		const trimmed = line.trim();
		if (trimmed === "<details>") {
			// collect the whole details block
			const block: string[] = [];
			let j = i;
			while (j < lines.length) {
				block.push(lines[j]!);
				if (lines[j]!.trim().startsWith("</details")) {
					break;
				}
				j++;
			}
			const summary = block
				.map((l) => l.trim().match(/^<summary>(.*)<\/summary>\s*$/)?.[1])
				.find((s) => s !== undefined);
			const m = summary?.match(SUMMARY_RE);
			if (m) {
				const srcSha = m[1] as string;
				const visSha = (m[2] as string | undefined) ?? null;
				const fenceStart = block.findIndex((l) =>
					l.trim().startsWith("```"),
				);
				let fenceEnd = -1;
				for (let k = fenceStart + 1; k < block.length; k++) {
					if (block[k]!.trim().startsWith("```")) {
						fenceEnd = k;
					}
				}
				let bytes: Uint8Array | null = null;
				if (fenceStart !== -1 && fenceEnd > fenceStart) {
					const compact = block
						.slice(fenceStart + 1, fenceEnd)
						.join("")
						.replace(/\s+/g, "");
					try {
						const buf = new Uint8Array(
							base64ToArrayBuffer(compact),
						);
						if ((await sha256Hex(buf)) === srcSha) {
							bytes = buf;
						}
					} catch {
						bytes = null;
					}
				}
				source = { srcSha, visSha, bytes };
			} else {
				out.push(...block);
			}
			i = j + 1;
			continue;
		}
		if (trimmed.startsWith("<page") || trimmed.startsWith("<database")) {
			childPageLines.push(trimmed);
			i++;
			continue;
		}
		out.push(line);
		i++;
	}

	return { visible: out.join("\n").trim(), childPageLines, source };
}

export function visibleHash(visible: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(visible));
}

export type PullDecision =
	| { kind: "source"; bytes: Uint8Array }
	| { kind: "converted" };

/** Given split page markdown, decide where content comes from. */
export function decidePullContent(
	split: SplitResult,
	currentVisSha: string,
): PullDecision {
	const s = split.source;
	if (
		s &&
		s.bytes !== null &&
		s.visSha !== null &&
		s.visSha === currentVisSha
	) {
		return { kind: "source", bytes: s.bytes };
	}
	return { kind: "converted" };
}
