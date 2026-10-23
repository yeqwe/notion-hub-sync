// Tiny worker-pool helper: run fn over items with at most `max` in flight.

export async function runPool<T>(
	items: readonly T[],
	max: number,
	fn: (item: T) => Promise<void>,
): Promise<void> {
	let i = 0;
	const workers = Array.from(
		{ length: Math.min(max, items.length) },
		async () => {
			while (i < items.length) {
				const item = items[i++]!;
				await fn(item);
			}
		},
	);
	await Promise.all(workers);
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
