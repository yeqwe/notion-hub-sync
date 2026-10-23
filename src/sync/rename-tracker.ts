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

	/** Called by the rename-event listener. true → this was ours, skip. */
	consume(from: string, to: string): boolean {
		return this.expected.delete(this.key(from, to));
	}
}
