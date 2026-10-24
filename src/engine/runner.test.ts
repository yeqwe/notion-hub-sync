import { describe, expect, it } from "vitest";
import { SyncRunner, type EngineDeps } from "./sync";
import { newReport } from "../sync/deps";
import { RenameTracker } from "../sync/rename-tracker";

function stubDeps(): EngineDeps {
	return {
		vault: {
			list: async () => ({ files: [], folders: [] }),
			readText: async () => "",
			readBinary: async () => new ArrayBuffer(0),
			writeText: async () => {},
			writeBinary: async () => {},
			mkdirp: async () => {},
			exists: async () => false,
			stat: async () => null,
			rename: async () => {},
			trash: async () => {},
			renames: new RenameTracker(),
		writes: new RenameTracker(),
		},
		client: null as unknown as EngineDeps["client"],
		state: { version: 1, rootPageId: "root", entries: {} },
		saveState: async () => {},
		resolvePath: () => null,
		deviceId: "dev",
		baseStore: null as unknown as EngineDeps["baseStore"],
		engine: { fullAuditHours: 6, roundRobinPerRound: 10 },
	};
}

describe("SyncRunner", () => {
	it("concurrent requests coalesce into one follow-up round", async () => {
		let rounds = 0;
		let concurrent = 0;
		let maxConcurrent = 0;
		let release: () => void = () => {};
		const gate = () =>
			new Promise<void>((r) => {
				release = r;
			});
		const runner = new SyncRunner(
			async () => stubDeps(),
			undefined,
			async () => {
				rounds++;
				concurrent++;
				maxConcurrent = Math.max(maxConcurrent, concurrent);
				await gate();
				concurrent--;
				return newReport();
			},
		);
		const p1 = runner.request();
		// give the first round a tick to start
		await new Promise((r) => setTimeout(r, 5));
		const p2 = runner.request();
		const p3 = runner.request(true);
		release(); // finish round 1 → follow-up round runs
		await new Promise((r) => setTimeout(r, 20));
		release(); // finish round 2
		await Promise.all([p1, p2, p3]);
		expect(rounds).toBe(2);
		expect(maxConcurrent).toBe(1);
	});

	it("a follow-up round is light only if every coalesced request was", async () => {
		const seen: Array<{ full: boolean; light: boolean }> = [];
		let release: () => void = () => {};
		const runner = new SyncRunner(
			async () => stubDeps(),
			undefined,
			async (_deps, opts) => {
				seen.push({
					full: opts.full,
					light: opts.light === true,
				});
				await new Promise<void>((r) => {
					release = r;
				});
				return newReport();
			},
		);
		const drain = async () => {
			release();
			await new Promise((r) => setTimeout(r, 20));
		};

		// two light requests fold into one light follow-up
		const a1 = runner.request(false, false, true);
		await new Promise((r) => setTimeout(r, 5));
		const a2 = runner.request(false, false, true);
		const a3 = runner.request(false, false, true);
		await drain(); // round 1
		await drain(); // follow-up
		await Promise.all([a1, a2, a3]);
		expect(seen).toEqual([
			{ full: false, light: true },
			{ full: false, light: true },
		]);

		// one non-light request in the batch poisons the follow-up
		seen.length = 0;
		const b1 = runner.request(false, false, true);
		await new Promise((r) => setTimeout(r, 5));
		const b2 = runner.request(false, false, true);
		const b3 = runner.request(); // plain request → must scan
		await drain();
		await drain();
		await Promise.all([b1, b2, b3]);
		expect(seen).toEqual([
			{ full: false, light: true },
			{ full: false, light: false },
		]);

		// a forced audit also forces the scan back on
		seen.length = 0;
		const c1 = runner.request(false, false, true);
		await new Promise((r) => setTimeout(r, 5));
		const c2 = runner.request(false, true, true);
		await drain();
		await drain();
		await Promise.all([c1, c2]);
		expect(seen).toEqual([
			{ full: false, light: true },
			{ full: false, light: false },
		]);
	});

	it("fetches fresh deps per round", async () => {
		let depsCalls = 0;
		const runner = new SyncRunner(
			async () => {
				depsCalls++;
				return stubDeps();
			},
			undefined,
			async () => newReport(),
		);
		await runner.request();
		await runner.request();
		expect(depsCalls).toBe(2);
	});
});

describe("RenameTracker", () => {
	it("consume() matches exactly once per expected rename", () => {
		const t = new RenameTracker();
		t.expect("Old.md", "New.md");
		expect(t.consume("Old.md", "New.md")).toBe(true);
		expect(t.consume("Old.md", "New.md")).toBe(false); // consumed
		expect(t.consume("User.md", "User2.md")).toBe(false);
	});
});
