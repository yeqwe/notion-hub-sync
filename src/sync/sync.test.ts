import { describe, expect, it } from "vitest";
import {
	buildSourceToggle,
	decidePullContent,
	splitPageMarkdown,
	summaryLine,
	visibleHash,
	VIS_PLACEHOLDER,
} from "./toggle";
import { buildMultipart, planUpload } from "./upload";
import {
	collisionFreePath,
	conflictPath,
	sanitizeTitle,
} from "./paths";
import { sha256Hex } from "./hashes";
import { arrayBufferToBase64 } from "obsidian";
import {
	NotionClient,
	type HttpRequest,
	type HttpResponse,
} from "../notion/client";

const enc = new TextEncoder();

async function toggleFor(text: string) {
	const bytes = enc.encode(text);
	const srcSha = await sha256Hex(bytes);
	return { bytes, srcSha };
}

describe("buildSourceToggle", () => {
	it("wraps base64 at 76 chars with the summary line", async () => {
		const { bytes, srcSha } = await toggleFor("hello source");
		const t = buildSourceToggle(srcSha, VIS_PLACEHOLDER, bytes)!;
		const lines = t.split("\n");
		expect(lines[0]).toBe("<details>");
		expect(lines[1]).toBe(summaryLine(srcSha, VIS_PLACEHOLDER));
		expect(lines[2]).toBe("\t```plain text");
		expect(lines[lines.length - 2]).toBe("\t```");
		expect(lines[lines.length - 1]).toBe("</details>");
		for (const l of lines.slice(3, -2)) {
			expect(l.length).toBeLessThanOrEqual(76);
			expect(l.startsWith("\t")).toBe(false);
		}
	});

	it("returns null over 150k bytes", () => {
		expect(
			buildSourceToggle("x".repeat(64), "y".repeat(64), new Uint8Array(150_001)),
		).toBeNull();
	});
});

describe("splitPageMarkdown", () => {
	it("extracts toggle anywhere and decodes bytes", async () => {
		const { bytes, srcSha } = await toggleFor("body content 中文");
		const visSha = await visibleHash("visible part");
		const toggle = buildSourceToggle(srcSha, visSha, bytes)!;
		const md = `visible part\n<page url="https://app.notion.com/p/${"a".repeat(32)}">x</page>\n${toggle}\npara 2`;
		const split = await splitPageMarkdown(md);
		expect(split.visible).toBe("visible part\npara 2");
		expect(split.childPageLines).toHaveLength(1);
		expect(split.source?.srcSha).toBe(srcSha);
		expect(split.source?.visSha).toBe(visSha);
		expect(new TextDecoder().decode(split.source!.bytes!)).toBe(
			"body content 中文",
		);
	});

	it("bytes null on sha mismatch; missing visible: → visSha null", async () => {
		const { srcSha } = await toggleFor("x");
		const bad = `<details>\n<summary>🔒 obsidian-source v1 sha256:${srcSha}</summary>\n\t\`\`\`plain text\n${arrayBufferToBase64(enc.encode("tampered").buffer as ArrayBuffer)}\n\t\`\`\`\n</details>`;
		const split = await splitPageMarkdown(`para\n${bad}`);
		expect(split.visible).toBe("para");
		expect(split.source?.visSha).toBeNull();
		expect(split.source?.bytes).toBeNull();
	});

	it("collects database lines too", async () => {
		const split = await splitPageMarkdown(
			'a\n<database url="u">db</database>\nb',
		);
		expect(split.childPageLines[0]).toContain("<database");
	});
});

describe("decidePullContent", () => {
	it("picks source when visSha matches, else converted", async () => {
		const { bytes, srcSha } = await toggleFor("content");
		const visSha = await visibleHash("v");
		const good = {
			visible: "v",
			childPageLines: [],
			source: { srcSha, visSha, bytes },
		};
		expect(decidePullContent(good, visSha).kind).toBe("source");
		expect(
			decidePullContent(good, "f".repeat(64)).kind,
		).toBe("converted");
		expect(
			decidePullContent(
				{ ...good, source: { srcSha, visSha: null, bytes } },
				visSha,
			).kind,
		).toBe("converted");
		expect(
			decidePullContent({ ...good, source: null }, visSha).kind,
		).toBe("converted");
	});
});

describe("planUpload", () => {
	it("keeps supported extensions, maps content type + block type", () => {
		expect(planUpload("pic.png")).toEqual({
			filename: "pic.png",
			contentType: "image/png",
			blockType: "image",
		});
		expect(planUpload("doc.pdf").blockType).toBe("pdf");
		expect(planUpload("song.mp3").blockType).toBe("audio");
		expect(planUpload("clip.mp4").blockType).toBe("video");
		expect(planUpload("note.md").contentType).toBe("text/markdown");
	});

	it("falls back to .txt + text/plain for unsupported/missing ext", () => {
		expect(planUpload("board.canvas")).toEqual({
			filename: "board.canvas.txt",
			contentType: "text/plain",
			blockType: "file",
		});
		expect(planUpload("blob.bin").filename).toBe("blob.bin.txt");
		expect(planUpload("noext").filename).toBe("noext.txt");
	});
});

describe("buildMultipart", () => {
	it("builds a byte-exact body", () => {
		const data = new TextEncoder().encode("DATA123");
		const body = new Uint8Array(
			buildMultipart("f.txt", "text/plain", data, "BND"),
		);
		const head = new TextEncoder().encode(
			'--BND\r\nContent-Disposition: form-data; name="file"; filename="f.txt"\r\nContent-Type: text/plain\r\n\r\n',
		);
		const tail = new TextEncoder().encode("\r\n--BND--\r\n");
		expect(body.subarray(0, head.length)).toEqual(head);
		expect(body.subarray(head.length, head.length + 7)).toEqual(data);
		expect(body.subarray(head.length + 7)).toEqual(tail);
	});
});

describe("paths", () => {
	it("sanitizes titles and handles empty", () => {
		expect(sanitizeTitle('a/b:c*d?e"f<g>h|i')).toBe("a-b-c-d-e-f-g-h-i");
		expect(sanitizeTitle("   ")).toBe("Untitled");
	});

	it("collides with (2), (3)", () => {
		const used = new Set(["dir/note.md"]);
		expect(collisionFreePath("dir/", "note.md", used)).toBe(
			"dir/note (2).md",
		);
		expect(collisionFreePath("dir/", "note.md", used)).toBe(
			"dir/note (3).md",
		);
	});

	it("names conflict copies pickpen-style", () => {
		const p = conflictPath(
			"Sub/Note.md",
			"abc123",
			new Date("2026-10-22T12:34:56.789Z"),
		);
		expect(p).toBe(
			"Sub/Note (conflict abc123 2026-10-22T12-34-56-789Z).md",
		);
	});
});

describe("NotionClient raw + download", () => {
	function harness(respond: (r: HttpRequest) => HttpResponse) {
		const calls: HttpRequest[] = [];
		const client = new NotionClient({
			token: "t",
			minIntervalMs: 0,
			maxRetries: 0,
			request: async (r) => {
				calls.push(r);
				return respond(r);
			},
		});
		return { client, calls };
	}

	it("requestRaw sends binary body with given content-type", async () => {
		const { client, calls } = harness(() => ({
			status: 200,
			json: { ok: true },
			headers: {},
		}));
		const body = new TextEncoder().encode("bin").buffer as ArrayBuffer;
		await client.requestRaw("POST", "/file_uploads/x/send", body, "multipart/form-data; boundary=B");
		expect(calls[0]!.body).toBe(body);
		expect(calls[0]!.headers["Content-Type"]).toBe(
			"multipart/form-data; boundary=B",
		);
		expect(calls[0]!.headers.Authorization).toBe("Bearer t");
	});

	it("download GETs without Authorization and returns bytes", async () => {
		const bytes = new TextEncoder().encode("file-bytes").buffer as ArrayBuffer;
		const { client, calls } = harness(() => ({
			status: 200,
			json: null,
			headers: {},
			arrayBuffer: bytes,
		}));
		const out = await client.download("https://s3.example/signed");
		expect(new Uint8Array(out)).toEqual(new Uint8Array(bytes));
		expect(calls[0]!.headers.Authorization).toBeUndefined();
		expect(calls[0]!.method).toBe("GET");
	});
});
