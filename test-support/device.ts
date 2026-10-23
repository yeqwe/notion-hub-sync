// Two-device test harness: one FakeNotion shared by N devices, each with
// its own temp vault dir, sync state, and base store.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NotionClient, type RequestFn } from "../src/notion/client";
import { emptyState, type SyncState } from "../src/sync/state";
import type { SyncReport } from "../src/sync/deps";
import { NodeVaultIO } from "./node-vault-io";
import { FakeNotion } from "./fake-notion";
import { BaseStore, type TextIO } from "../src/engine/base-store";
import { runSync, type EngineDeps } from "../src/engine/sync";
import { NodeConfigIO } from "./node-config-io";
import {
	defaultConfigSync,
	type ConfigSyncSettings,
} from "../src/config/filter";

function nodeTextIO(root: string): TextIO {
	return {
		read: async (p) => readFileSync(join(root, p), "utf8"),
		write: async (p, c) => {
			const abs = join(root, p);
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, c);
		},
		remove: async (p) => {
			try {
				unlinkSync(join(root, p));
			} catch {
				/* missing */
			}
		},
	};
}

export interface Device {
	dir: string;
	vault: NodeVaultIO;
	state: SyncState;
	deps: EngineDeps;
	sync(full?: boolean): Promise<SyncReport>;
	write(path: string, text: string): void;
	read(path: string): string;
}

export function makeDevice(
	fake: FakeNotion,
	rootId: string,
	label: string,
	opts?: {
		request?: RequestFn;
		fullAuditHours?: number;
		roundRobinPerRound?: number;
		configSync?: ConfigSyncSettings;
		selfId?: string;
	},
): Device {
	const dir = mkdtempSync(join(tmpdir(), `nhs-${label}-`));
	const vault = new NodeVaultIO(dir);
	const state = emptyState(rootId.replace(/-/g, "").toLowerCase());
	const deps: EngineDeps = {
		vault,
		client: new NotionClient({
			token: "fake",
			request: opts?.request ?? fake.request,
			minIntervalMs: 0,
			maxRetries: 0,
		}),
		state,
		saveState: async () => {},
		resolvePath: () => null,
		deviceId: `${label}0000-0000-4000-8000-000000000000`,
		history: {
			enabled: true,
			intervalMinutes: 0,
			maxVersions: 50,
			retentionDays: 30,
		},
		baseStore: new BaseStore(nodeTextIO(dir), ".nhs"),
		configIO: new NodeConfigIO(dir),
		configSync: opts?.configSync ?? defaultConfigSync(),
		selfId: opts?.selfId ?? "notion-hub-sync",
		isMobile: false,
		engine: {
			fullAuditHours: opts?.fullAuditHours ?? 10_000,
			roundRobinPerRound: opts?.roundRobinPerRound ?? 0,
		},
		now: () => fake.now,
	};
	return {
		dir,
		vault,
		state,
		deps,
		sync: (full = false) => runSync(deps, { full }),
		write: (path, text) => {
			const abs = join(dir, ...path.split("/"));
			mkdirSync(dirname(abs), { recursive: true });
			writeFileSync(abs, text);
		},
		read: (path) => readFileSync(join(dir, ...path.split("/")), "utf8"),
	};
}

/** Synchronous exists for test assertions. */
export function fileExists(device: Device, path: string): boolean {
	try {
		readFileSync(join(device.dir, ...path.split("/")));
		return true;
	} catch {
		return false;
	}
}
