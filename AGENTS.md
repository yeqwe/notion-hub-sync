# AGENTS.md

Obsidian plugin: whole-vault multi-device sync through Notion (page tree as the hub). TypeScript strict, esbuild bundle, Vitest tests. Desktop + mobile (`isDesktopOnly: false`) — **no Node/Electron APIs in `src/`** (no `require`, `fs`, `path`, `Buffer`, `process`).

## Commands

- `npm test` — unit + offline tests (Vitest, `src/**/*.test.ts`)
- `npm run build` — `tsc -noEmit` + esbuild → `main.js`
- `npm run test:live` — live tests against **real** Notion (`vitest.live.config.ts`, `src/**/*.live.test.ts`); needs `.env.local` with `NOTION_TOKEN` + `NOTION_ROOT_PAGE`; creates container pages and trashes them
- `node scripts/probe-mN.mjs` — ad-hoc API probes (same env)

## Layout

- `src/notion/` — HTTP client (`RequestFn` abstraction, retry, rate limit), id parsing
- `src/convert/` — Obsidian ↔ Notion enhanced-markdown converters + link resolution
- `src/sync/` — shared helpers: paths, upload (single + multi-part), hashes, toggle (lossless source block), history (versions), state, VaultIO, rename/write trackers
- `src/engine/` — M4 3-way incremental sync: `types`/`plan`/`merge3` (pure), `local`/`remote` snapshots, `journal`, `base-store`, `apply`, `sync` (`runSync` + coalescing `SyncRunner`)
- `src/config/` — M5 `.obsidian` settings sync: `filter` (category rules), `plan` (pure planner), `sync`, `config-io` (Obsidian + Node impls)
- `src/ui/` — settings tab, history/deleted-files/status modals
- `src/main.ts` — plugin entry: commands, ribbon/status, auto-sync wiring (`src/auto-sync.ts`)
- `test-support/` — `FakeNotion` (in-memory API, `RequestFn`), `NodeVaultIO`, `NodeConfigIO`, `device.ts` two-device harness
- `学习项目/` — pickpen reference code (read-only, never modify)

## Language

- 始终用中文回复用户（代码、注释、标识符仍按现有风格用英文）。

## Conventions

- Identity = Notion page id (hex32); `state.entries` is the merge base; journal ops (`c`/`m`/`n`/`t`) propagate remote changes between devices.
- Reserved system pages: 🧾 journal, 🗄️ history, ⚙️ config — excluded from vault tree walks and candidate evals.
- Remote "absent from map" = not evaluated (unchanged); deletions are explicit markers.
- Engine writes/renames register in `VaultIO.writes`/`renames` trackers so vault-event listeners can tell engine ops from user ops (auto-sync + rename hints).
- `last_edited_time` is minute-rounded and unreliable — never use it for change detection.
- Modules ~≤300 lines where practical.
