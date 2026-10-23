// Ring-buffered sync log shared by the status panel and persisted to
// <plugin dir>/sync-log.json. Pure module — no Obsidian imports.

export type LogLevel = "info" | "success" | "warn" | "error";

export interface LogEntry {
	t: number;
	level: LogLevel;
	msg: string;
	/** Vault path this entry refers to — clickable in the panel. */
	path?: string;
}

const LEVELS: readonly LogLevel[] = ["info", "success", "warn", "error"];

export interface SyncLogOpts {
	cap?: number;
	now?: () => number;
	persist?: (entries: LogEntry[]) => Promise<void>;
}

export class SyncLog {
	private readonly cap: number;
	private readonly now: () => number;
	private readonly persist?: (entries: LogEntry[]) => Promise<void>;
	private items: LogEntry[] = [];
	private listeners = new Set<() => void>();

	constructor(opts: SyncLogOpts = {}) {
		this.cap = opts.cap ?? 500;
		this.now = opts.now ?? (() => Date.now());
		this.persist = opts.persist;
	}

	add(level: LogLevel, msg: string, path?: string): void {
		const entry: LogEntry = { t: this.now(), level, msg };
		// a bare Notion id is not a vault path — nothing to click
		if (path && !/^[0-9a-f]{32}$/i.test(path)) entry.path = path;
		this.items.push(entry);
		if (this.items.length > this.cap) {
			this.items = this.items.slice(-this.cap);
		}
		this.notify();
	}

	info(msg: string, path?: string): void {
		this.add("info", msg, path);
	}
	success(msg: string, path?: string): void {
		this.add("success", msg, path);
	}
	warn(msg: string, path?: string): void {
		this.add("warn", msg, path);
	}
	error(msg: string, path?: string): void {
		this.add("error", msg, path);
	}

	/** Oldest first. */
	entries(): readonly LogEntry[] {
		return this.items;
	}

	/** Accept parsed JSON from disk; malformed items are dropped. */
	load(entries: unknown): void {
		const clean: LogEntry[] = [];
		if (Array.isArray(entries)) {
			for (const raw of entries) {
				if (!raw || typeof raw !== "object") continue;
				const e = raw as Partial<LogEntry>;
				if (
					typeof e.t === "number" &&
					typeof e.msg === "string" &&
					LEVELS.includes(e.level as LogLevel)
				) {
					const entry: LogEntry = {
						t: e.t,
						level: e.level as LogLevel,
						msg: e.msg,
					};
					if (typeof e.path === "string" && e.path !== "") {
						entry.path = e.path;
					}
					clean.push(entry);
				}
			}
		}
		this.items = clean.slice(-this.cap);
		this.notify();
	}

	clear(): void {
		this.items = [];
		this.notify();
		void this.flush();
	}

	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => {
			this.listeners.delete(cb);
		};
	}

	async flush(): Promise<void> {
		if (!this.persist) return;
		try {
			await this.persist([...this.items]);
		} catch {
			// persistence is best-effort
		}
	}

	private notify(): void {
		for (const cb of [...this.listeners]) cb();
	}
}
