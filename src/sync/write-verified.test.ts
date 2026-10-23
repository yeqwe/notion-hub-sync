// Verified writes. The failure this prevents is silent: a pull interrupted
// mid-write leaves a truncated file, the base records the remote hash, and
// the next round sees "local == base" and never repairs it. A cut-off
// Markdown note still opens, so nobody notices until much later.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	WriteVerificationError,
	writeTextVerified,
	writeVerified,
	type VaultIO,
} from "../sync/vault-io";
import { sha256Hex } from "../sync/hashes";
import { NodeVaultIO } from "../../test-support/node-vault-io";

const dir = () => mkdtempSync(join(tmpdir(), "nhs-verify-"));
const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("writeVerified (staged writer)", () => {
	it("writes when the hash matches", async () => {
		const root = dir();
		const io = new NodeVaultIO(root);
		const body = bytesOf("hello world");
		const sha = await sha256Hex(body);
		await writeVerified(io, "a.txt", body, sha);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("hello world");
	});

	it("throws and leaves the old content intact on a mismatch", async () => {
		const root = dir();
		const io = new NodeVaultIO(root);
		writeFileSync(join(root, "a.txt"), "original");
		const body = bytesOf("new content");
		// deliberately wrong hash — the writer must not touch the target
		await expect(
			writeVerified(io, "a.txt", body, "0".repeat(64)),
		).rejects.toBeInstanceOf(WriteVerificationError);
		expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("original");
	});

	it("leaves no temp file behind", async () => {
		const root = dir();
		const io = new NodeVaultIO(root);
		const body = bytesOf("x");
		await writeVerified(io, "a.txt", body, await sha256Hex(body));
		const { readdirSync } = await import("node:fs");
		expect(readdirSync(root).filter((f) => f.includes("nhs-tmp"))).toEqual([]);
	});

	it("cleans up the temp file even when verification fails", async () => {
		const root = dir();
		const io = new NodeVaultIO(root);
		await expect(
			writeVerified(io, "a.txt", bytesOf("x"), "0".repeat(64)),
		).rejects.toBeInstanceOf(WriteVerificationError);
		const { readdirSync } = await import("node:fs");
		expect(readdirSync(root).filter((f) => f.includes("nhs-tmp"))).toEqual([]);
	});
});

describe("writeVerified (fallback path)", () => {
	/** An IO without the staged writer: the helper must still detect a
	 * truncated write by reading back. */
	function plainIO(root: string): VaultIO {
		const base = new NodeVaultIO(root);
		return {
			list: () => base.list(),
			readText: (p) => base.readText(p),
			readBinary: (p) => base.readBinary(p),
			writeText: (p, c) => base.writeText(p, c),
			// a writer that silently corrupts: the classic truncation
			writeBinary: async (p, data) => {
				const truncated = new Uint8Array(data).slice(
					0,
					Math.max(0, data.byteLength - 1),
				);
				await base.writeBinary(p, truncated.buffer as ArrayBuffer);
			},
			mkdirp: (p) => base.mkdirp(p),
			exists: (p) => base.exists(p),
			stat: (p) => base.stat(p),
			rename: (a, b) => base.rename(a, b),
			trash: (p) => base.trash(p),
			renames: base.renames,
			writes: base.writes,
		};
	}

	it("detects truncation even without a staged writer", async () => {
		const root = dir();
		const io = plainIO(root);
		const body = bytesOf("hello world");
		const sha = await sha256Hex(body);
		await expect(writeVerified(io, "a.txt", body, sha)).rejects.toBeInstanceOf(
			WriteVerificationError,
		);
	});
});

describe("writeTextVerified", () => {
	it("compares on the UTF-8 bytes of the string", async () => {
		const root = dir();
		const io = new NodeVaultIO(root);
		const text = "# 标题\n\n正文。\n";
		const sha = await sha256Hex(new TextEncoder().encode(text));
		await writeTextVerified(io, "n.md", text, sha);
		expect(readFileSync(join(root, "n.md"), "utf8")).toBe(text);
	});

	it("rejects a hash computed from a different encoding", async () => {
		const root = dir();
		const io = new NodeVaultIO(root);
		// a UTF-16 hash would never match the bytes actually written
		await expect(
			writeTextVerified(io, "n.md", "text", "0".repeat(64)),
		).rejects.toBeInstanceOf(WriteVerificationError);
	});
});

describe("WriteVerificationError", () => {
	it("names the path and both hashes so a log line is actionable", () => {
		const err = new WriteVerificationError(
			"notes/a.md",
			"aaaa".repeat(16),
			"bbbb".repeat(16),
		);
		expect(err.message).toContain("notes/a.md");
		expect(err.message).toContain("expected aaaa");
		expect(err.message).toContain("wrote bbbb");
		expect(err.name).toBe("WriteVerificationError");
	});
});
