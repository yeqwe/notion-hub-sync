// Engine-initiated renames (moveLocal, conflict copies, collision fixes)
// must not be recorded as user rename hints. VaultIO.rename() registers
// the rename here; the vault "rename" event listener consumes it.

export class RenameTracker {
	private readonly expected = new Set<string>();

	private key(from: string, to: string): string {
		return `${from}\n${to}`;
	}

	/** Called by VaultIO.rename before the rename happens. */
	expect(from: string, to: string): void {
		this.expected.add(this.key(from, to));
	}

	/** Withdraw an expectation that will never be met (e.g. the operation
	 * turned out to be a no-op, so no event fires). Without it a stale entry
	 * survives and later swallows a REAL user operation on the same path. */
	forget(from: string, to: string): void {
		this.expected.delete(this.key(from, to));
	}

	/** Called by the rename-event listener. true → this was ours, skip. */
	consume(from: string, to: string): boolean {
		return this.expected.delete(this.key(from, to));
	}
}
