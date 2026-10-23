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
