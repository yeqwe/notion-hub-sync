// Tiny worker-pool helpers: bounded concurrency, bounded memory.
//
// Concurrency is limited in BYTES, not in items. "3 at a time" is fine for
// 1 KB notes and fatal for 200 MB videos: three of them in flight is 600 MB
// of live ArrayBuffers, and this plugin runs on phones. A single item larger
// than the whole budget gets the pool to itself (admitted only when nothing
// else is running), so big files serialize instead of stacking up.

/** In-flight byte budget per platform. */
export const CONTENT_BUDGET = {
	desktop: 96 * 1024 * 1024,
	mobile: 32 * 1024 * 1024,
} as const;

/** Size assumed for an item whose real size is unknown — small enough to
 * still allow concurrency, big enough not to admit ten at once. */
const UNKNOWN_SIZE_BYTES = 8 * 1024 * 1024;

export interface PoolBudget<T> {
	/** Bytes this item will hold in memory while its task runs. */
	sizeOf(item: T): number;
	/** Total in-flight bytes allowed. */
	budgetBytes: number;
}

export async function runPool<T>(
	items: readonly T[],
	max: number,
	fn: (item: T) => Promise<void>,
	budget?: PoolBudget<T>,
): Promise<void> {
	let i = 0;
	const workers = Array.from(
		{ length: Math.max(1, Math.min(max, items.length)) },
		async () => {
			while (i < items.length) {
				const item = items[i++]!;
				await fn(item);
			}
		},
	);
	await Promise.all(workers);
}

/**
 * Bounded-concurrency map that also enforces a byte budget. Results come
 * back in input order. The first rejection stops admission of new work and
 * rejects the whole call; tasks already in flight run to completion (their
 * rejections are swallowed — the first one is the one reported).
 *
 * @param budget optional; without it this is just `runPool` returning results.
 */
export async function mapConcurrent<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
	budget?: PoolBudget<T>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	if (items.length === 0) return results;
	const maxActive = Math.max(1, limit);
	const sizeOf = budget?.sizeOf;
	const budgetBytes = budget?.budgetBytes ?? 0;
	let next = 0;
	let active = 0;
	let activeBytes = 0;
	let failed = false;

	const canAdmit = (size: number): boolean => {
		if (active >= maxActive) return false;
		if (!sizeOf) return true;
		// an item bigger than the whole budget may still run when it is alone
		if (active === 0) return true;
		return activeBytes + size <= budgetBytes;
	};

	await new Promise<void>((resolve, reject) => {
		const pump = (): void => {
			if (failed) return;
			while (
				next < items.length &&
				canAdmit(sizeOf ? sizeOf(items[next]!) : 0)
			) {
				const i = next++;
				const size = sizeOf ? sizeOf(items[i]!) : 0;
				active++;
				activeBytes += size;
				fn(items[i]!)
					.then(
						(r) => {
							results[i] = r;
						},
						(err: unknown) => {
							if (!failed) {
								failed = true;
								reject(
									err instanceof Error
										? err
										: new Error(String(err)),
								);
							}
						},
					)
					.finally(() => {
						active--;
						activeBytes -= size;
						pump();
					});
			}
			if (active === 0 && next >= items.length) resolve();
		};
		pump();
	});
	return results;
}

/** Size accessor that falls back to UNKNOWN_SIZE_BYTES when missing. */
export function sizeOrUnknown(size: number | undefined | null): number {
	return typeof size === "number" && Number.isFinite(size) && size >= 0
		? size
		: UNKNOWN_SIZE_BYTES;
}

/** Counting semaphore — bounds total in-flight work across callers. */
export class Semaphore {
	private held = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(private readonly max: number) {}

	async acquire(): Promise<void> {
		if (this.held < this.max) {
			this.held++;
			return;
		}
		await new Promise<void>((r) => this.waiters.push(r));
		this.held++;
	}

	release(): void {
		this.held--;
		this.waiters.shift()?.();
	}
}

/** Yield to the event loop so a long scan never freezes the UI.
 * `tick()` inside a loop yields at most every `every` items or `everyMs`. */
export function createYieldControl(
	yieldFn: () => Promise<void> = yieldToEventLoop,
) {
	let count = 0;
	let last = Date.now();
	return {
		async tick(every = 100, everyMs = 50): Promise<void> {
			count++;
			if (count % every === 0 || Date.now() - last >= everyMs) {
				last = Date.now();
				await yieldFn();
			}
		},
		get count(): number {
			return count;
		},
	};
}

export function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, 0));
}
