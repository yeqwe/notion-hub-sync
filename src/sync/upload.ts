// File-upload helpers: extension → upload metadata, multipart body builder.

// Extensions accepted by the Notion File Upload API (see
// https://developers.notion.com/guides/working-with-files-and-media).
const SUPPORTED_EXTENSIONS = new Set(
	(
		"aac adts ai aif aifc aiff amr asf asx au avi bmp bsf css csv doc docm docx dot dotm dotx " +
		"dtd epub epub+zip flac flv gif gz heic htc htm html ico jpeg jpg json jsonld m4a m4v " +
		"markdown md mid midi mov mp3 mp4 mpa mpe mpeg mpg mpga odt oga ogg ogv opus " +
		"pdf png ppt pptm pptx pps ppsm ppsx rar rtf svg tar tex text tif tiff txt " +
		"wav webm webp wma wmv xls xlsm xlsx xml zip"
	).split(" "),
);

const EXT_TO_CONTENT_TYPE: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
	heic: "image/heic",
	ico: "image/x-icon",
	pdf: "application/pdf",
	md: "text/markdown",
	markdown: "text/markdown",
	txt: "text/plain",
	text: "text/plain",
	json: "application/json",
	csv: "text/csv",
	html: "text/html",
	htm: "text/html",
	css: "text/css",
	xml: "application/xml",
	zip: "application/zip",
	gz: "application/gzip",
	tar: "application/x-tar",
	rar: "application/vnd.rar",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	ogg: "audio/ogg",
	flac: "audio/flac",
	m4a: "audio/mp4",
	aac: "audio/aac",
	mp4: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
	avi: "video/x-msvideo",
	mkv: "video/x-matroska",
	mpg: "video/mpeg",
	mpeg: "video/mpeg",
	wmv: "video/x-ms-wmv",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	epub: "application/epub+zip",
};

const IMAGE_EXTS = new Set(
	"png jpg jpeg gif webp svg bmp tif tiff heic ico".split(" "),
);
const AUDIO_EXTS = new Set("mp3 wav ogg flac m4a aac mid midi".split(" "));
const VIDEO_EXTS = new Set("mp4 mov webm avi mkv mpg mpeg wmv flv m4v".split(" "));

export function extensionOf(name: string): string {
	const idx = name.lastIndexOf(".");
	return idx === -1 ? "" : name.slice(idx + 1).toLowerCase();
}

export type MediaBlockType = "image" | "pdf" | "audio" | "video" | "file";

export function blockTypeFor(ext: string): MediaBlockType {
	if (IMAGE_EXTS.has(ext)) return "image";
	if (ext === "pdf") return "pdf";
	if (AUDIO_EXTS.has(ext)) return "audio";
	if (VIDEO_EXTS.has(ext)) return "video";
	return "file";
}

export interface UploadPlan {
	filename: string;
	contentType: string;
	blockType: MediaBlockType;
}

/**
 * Decide upload filename/content-type. Unsupported extensions (incl. no
 * extension) fall back to `<name>.txt` + text/plain — verified
 * byte-identical on download.
 */
export function planUpload(originalName: string): UploadPlan {
	const ext = extensionOf(originalName);
	if (ext !== "" && SUPPORTED_EXTENSIONS.has(ext)) {
		return {
			filename: originalName,
			contentType: EXT_TO_CONTENT_TYPE[ext] ?? "application/octet-stream",
			blockType: blockTypeFor(ext),
		};
	}
	return {
		filename: `${originalName}.txt`,
		contentType: "text/plain",
		blockType: blockTypeFor(ext),
	};
}

const textEncoder = new TextEncoder();

/** Build a multipart/form-data body: optional text fields + one `file`
 * part (extra fields come first, e.g. `part_number` for multi-part). */
export function buildMultipart(
	filename: string,
	contentType: string,
	data: Uint8Array,
	boundary: string,
	fields?: Record<string, string>,
): ArrayBuffer {
	let prefix = "";
	for (const [k, v] of Object.entries(fields ?? {})) {
		prefix +=
			`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
	}
	const head = textEncoder.encode(
		prefix +
			`--${boundary}\r\n` +
			`Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
			`Content-Type: ${contentType}\r\n\r\n`,
	);
	const tail = textEncoder.encode(`\r\n--${boundary}--\r\n`);
	const out = new Uint8Array(head.length + data.length + tail.length);
	out.set(head, 0);
	out.set(data, head.length);
	out.set(tail, head.length + data.length);
	return out.buffer;
}

// Multi-part upload (files > 20 MiB): 10 MiB parts per Notion's guide
// (each part 5–20 MiB except the last). Single-part below the threshold.
export const SINGLE_PART_MAX_BYTES = 20 * 1024 * 1024;
export const PART_SIZE_BYTES = 10 * 1024 * 1024;

export function partCount(size: number): number {
	return Math.ceil(size / PART_SIZE_BYTES);
}

export function partSlice(
	bytes: Uint8Array,
	partNumber: number, // 1-based
): Uint8Array {
	const start = (partNumber - 1) * PART_SIZE_BYTES;
	return bytes.subarray(
		start,
		Math.min(start + PART_SIZE_BYTES, bytes.byteLength),
	);
}

/** Content sha embedded in a media block's caption (`sha256:<hex>`).
 * Exact: a content replacement always produces a new media block, so a
 * caption hit means the remote bytes hash to that sha — no download. */
export function captionSha(block: {
	type: string;
	[key: string]: unknown;
}): string | null {
	const inner = block[block.type] as { caption?: unknown } | undefined;
	const caption = inner?.caption;
	if (!Array.isArray(caption)) return null;
	const text = caption
		.map(
			(seg) =>
				(
					(seg as { plain_text?: string; text?: { content?: string } })
						?.plain_text ??
					(seg as { text?: { content?: string } })?.text?.content ??
					""
				),
		)
		.join("");
	return text.match(/sha256:([0-9a-f]{64})\b/)?.[1] ?? null;
}

interface UploadCapableClient {
	request<T = unknown>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T>;
	requestRaw(
		method: string,
		path: string,
		body: ArrayBuffer,
		contentType?: string,
	): Promise<unknown>;
}

const newBoundary = () =>
	`----nhs${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;

/** Upload bytes to a new file_upload object; returns the upload id.
 * `onPart` fires after each sent part — (1,1) for single-part. */
export async function uploadBytes(
	client: UploadCapableClient,
	filename: string,
	contentType: string,
	bytes: Uint8Array,
	onPart?: (part: number, parts: number) => void,
): Promise<string> {
	const boundary = newBoundary();
	if (bytes.byteLength <= SINGLE_PART_MAX_BYTES) {
		const up = await client.request<{ id: string }>(
			"POST",
			"/file_uploads",
			{ filename, content_type: contentType },
		);
		await client.requestRaw(
			"POST",
			`/file_uploads/${up.id}/send`,
			buildMultipart(filename, contentType, bytes, boundary),
			`multipart/form-data; boundary=${boundary}`,
		);
		onPart?.(1, 1);
		return up.id;
	}
	const parts = partCount(bytes.byteLength);
	const up = await client.request<{ id: string }>(
		"POST",
		"/file_uploads",
		{
			mode: "multi_part",
			number_of_parts: parts,
			filename,
			content_type: contentType,
		},
	);
	for (let n = 1; n <= parts; n++) {
		await client.requestRaw(
			"POST",
			`/file_uploads/${up.id}/send`,
			buildMultipart(filename, contentType, partSlice(bytes, n), boundary, {
				part_number: String(n),
			}),
			`multipart/form-data; boundary=${boundary}`,
		);
		onPart?.(n, parts);
	}
	await client.request("POST", `/file_uploads/${up.id}/complete`);
	return up.id;
}
