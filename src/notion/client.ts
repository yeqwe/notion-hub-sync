import { requestUrl } from "obsidian";

const BASE_URL = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const DEFAULT_MIN_INTERVAL_MS = 334; // ≈3 req/s — Notion's average limit
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_MAX_CONCURRENT = 3;
const BACKOFF_BASE_MS = 1000;
const DOWNLOAD_TIMEOUT_BASE_MS = 60_000;
const DOWNLOAD_TIMEOUT_PER_MIB_MS = 1000;
/** Unknown payload size → assume the configured max file size (200 MiB). */
const DOWNLOAD_UNKNOWN_SIZE_BYTES = 200 * 1_048_576;

export interface HttpRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string | ArrayBuffer;
	/** Per-attempt timeout (downloads only). */
	timeoutMs?: number;
}

export interface HttpResponse {
	status: number;
	json: unknown;
	headers: Record<string, string>;
	arrayBuffer?: ArrayBuffer;
}

export type RequestFn = (req: HttpRequest) => Promise<HttpResponse>;

export class NotionApiError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
	) {
		super(message);
		this.name = "NotionApiError";
	}
}

export interface NotionClientOptions {
	token: string;
	request?: RequestFn;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	minIntervalMs?: number;
	maxRetries?: number;
	maxConcurrent?: number;
}

interface QueuedTask {
	build: () => HttpRequest & { raw?: boolean };
	/** api.notion.com requests get start-spacing; signed downloads don't. */
	isApi: boolean;
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
}

const defaultRequest: RequestFn = async (req) => {
	const res = await requestUrl({
		url: req.url,
		method: req.method,
		headers: req.headers,
		body: req.body,
		throw: false,
	});
	let json: unknown = null;
	try {
		json = res.json;
	} catch {
		json = null;
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(res.headers ?? {})) {
		headers[key.toLowerCase()] = value;
	}
	return { status: res.status, json, headers, arrayBuffer: res.arrayBuffer };
};

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

export class NotionClient {
	private readonly requestFn: RequestFn;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly now: () => number;
	private readonly minIntervalMs: number;
	private readonly maxRetries: number;
	private readonly token: string;
	private readonly maxConcurrent: number;
	private pending: QueuedTask[] = [];
	private inFlight = 0;
	private lastApiStart = -Infinity;
	/** 429 → no new request starts until this timestamp. */
	private blockedUntil = -Infinity;
	private wakePending = false;

	constructor(options: NotionClientOptions) {
		this.token = options.token;
		this.requestFn = options.request ?? defaultRequest;
		this.sleep = options.sleep ?? defaultSleep;
		this.now = options.now ?? Date.now;
		this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
		this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
	}

	request<T>(
		method: "GET" | "POST" | "PATCH" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<T> {
		return this.enqueue<T>(
			() => ({
				url: `${BASE_URL}${path}`,
				method,
				headers: this.apiHeaders("application/json"),
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
			true,
		);
	}

	/** Same limiter/retry, raw binary body + custom Content-Type. */
	requestRaw<T>(
		method: "POST" | "PATCH",
		path: string,
		body: ArrayBuffer,
		contentType: string,
	): Promise<T> {
		return this.enqueue<T>(
			() => ({
				url: `${BASE_URL}${path}`,
				method,
				headers: this.apiHeaders(contentType),
				body,
			}),
			true,
		);
	}

	/** GET a signed download URL — no Authorization header. Bypasses API
	 * start-spacing but shares the concurrency cap and the 429 pause.
	 * Times out (60 s + 1 s/MiB of sizeHint) instead of hanging. */
	download(
		url: string,
		opts?: { sizeHintBytes?: number },
	): Promise<ArrayBuffer> {
		const timeoutMs =
			DOWNLOAD_TIMEOUT_BASE_MS +
			Math.ceil(
				(opts?.sizeHintBytes ?? DOWNLOAD_UNKNOWN_SIZE_BYTES) / 1_048_576,
			) * DOWNLOAD_TIMEOUT_PER_MIB_MS;
		return this.enqueue<HttpResponse>(
			() => ({ url, method: "GET", headers: {}, timeoutMs, raw: true }),
			url.startsWith(BASE_URL),
		).then((res) => res.arrayBuffer ?? new ArrayBuffer(0));
	}

	private enqueue<T>(
		build: QueuedTask["build"],
		isApi: boolean,
	): Promise<T> {
		const task = new Promise<T>((resolve, reject) => {
			this.pending.push({
				build,
				isApi,
				resolve: resolve as (v: unknown) => void,
				reject,
			});
		});
		this.pump();
		void task.catch(() => undefined); // drain: keep queue healthy
		return task;
	}

	/** Start as many pending tasks as caps/spacing allow. */
	private pump(): void {
		while (this.inFlight < this.maxConcurrent && this.pending.length > 0) {
			const now = this.now();
			let idx = -1;
			let nextWait = Infinity;
			for (let i = 0; i < this.pending.length; i++) {
				const t = this.pending[i]!;
				const earliest = t.isApi
					? Math.max(this.lastApiStart + this.minIntervalMs, this.blockedUntil)
					: this.blockedUntil;
				const wait = earliest - now;
				if (wait <= 0) {
					idx = i;
					break;
				}
				if (wait < nextWait) nextWait = wait;
			}
			if (idx === -1) {
				this.scheduleWake(nextWait);
				return;
			}
			const t = this.pending.splice(idx, 1)[0]!;
			this.inFlight++;
			if (t.isApi) this.lastApiStart = now;
			this.runRequest<unknown>(t.build)
				.then(t.resolve, t.reject)
				.finally(() => {
					this.inFlight--;
					this.pump();
				});
		}
	}

	private scheduleWake(ms: number): void {
		if (this.wakePending || !Number.isFinite(ms)) return;
		this.wakePending = true;
		void this.sleep(ms).then(() => {
			this.wakePending = false;
			this.pump();
		});
	}

	private apiHeaders(contentType: string): Record<string, string> {
		return {
			Authorization: `Bearer ${this.token}`,
			"Notion-Version": NOTION_VERSION,
			"Content-Type": contentType,
		};
	}

	private async runRequest<T>(
		build: () => HttpRequest & { raw?: boolean },
	): Promise<T> {
		const { raw, timeoutMs, ...req } = build();

		for (let attempt = 0; ; attempt++) {
			let res: HttpResponse;
			try {
				res = await this.withTimeout(this.requestFn(req), timeoutMs);
			} catch (err) {
				if (attempt < this.maxRetries) {
					await this.sleep(BACKOFF_BASE_MS * 2 ** attempt);
					continue;
				}
				throw err instanceof NotionApiError
					? err
					: new NotionApiError(
							0,
							"network_error",
							err instanceof Error ? err.message : String(err),
						);
			}

			if (res.status >= 200 && res.status < 300) {
				return (raw ? res : res.json) as T;
			}

			const retriable = res.status === 429 || res.status >= 500;
			if (retriable && attempt < this.maxRetries) {
				const delay = this.retryDelayMs(res, attempt);
				if (res.status === 429) {
					// pause ALL new starts until Retry-After elapses
					this.blockedUntil = Math.max(
						this.blockedUntil,
						this.now() + delay,
					);
				}
				await this.sleep(delay);
				continue;
			}

			throw this.toApiError(res);
		}
	}

	private withTimeout<T>(p: Promise<T>, ms?: number): Promise<T> {
		if (!ms) return p;
		// real timer — deliberately not this.sleep (a fake clock must not
		// be advanced by an internal timeout that never fires)
		let timer: ReturnType<typeof setTimeout>;
		const timeout = new Promise<T>((_res, rej) => {
			timer = setTimeout(
				() => rej(new NotionApiError(0, "timeout", "download timed out")),
				ms,
			);
		});
		return Promise.race([
			p.finally(() => clearTimeout(timer)),
			timeout,
		]);
	}

	private retryDelayMs(res: HttpResponse, attempt: number): number {
		if (res.status === 429) {
			const retryAfter = this.header(res.headers, "retry-after");
			if (retryAfter !== undefined) {
				const seconds = Number(retryAfter);
				if (Number.isFinite(seconds) && seconds >= 0) {
					return seconds * 1000;
				}
			}
		}
		// ±10% jitter. Two devices on the same interval fire at the same
		// moment, both get 429, both wait exactly 1s, both retry together —
		// a fixed backoff synchronizes the retries it was meant to spread
		// out. The jitter keeps them from locking step.
		const base = BACKOFF_BASE_MS * 2 ** attempt;
		return Math.round(base * (0.9 + Math.random() * 0.2));
	}

	private header(
		headers: Record<string, string>,
		name: string,
	): string | undefined {
		const lower = name.toLowerCase();
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === lower) {
				return value;
			}
		}
		return undefined;
	}

	private toApiError(res: HttpResponse): NotionApiError {
		let code = "unknown_error";
		let message = `Notion API request failed with status ${res.status}`;
		const json = res.json;
		if (json !== null && typeof json === "object") {
			const record = json as Record<string, unknown>;
			if (typeof record.code === "string") {
				code = record.code;
			}
			if (typeof record.message === "string") {
				message = record.message;
			}
		}
		return new NotionApiError(res.status, code, message);
	}
}
