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

## Git workflow

- **改完就推送，不要停在本地等确认。** 流程固定为：`npm test` + `npx tsc -noEmit` 全绿 → 提交 → `git push origin main` → 打 tag 触发 Release。
- **每次改动都要升版本**：`manifest.json`、`package.json`、`package-lock.json`、`versions.json` 四处必须一致。CI 会校验 tag 与 `manifest.json` 的 `version`，不信则 release 失败。
- 版本号递增规则：修复 `x.y.Z+1`，新功能 `x.Y+1.0`。用户靠 BRAT 从 Release 更新，版本号不变就收不到更新。
- tag 形如 `0.2.2`（不带 `v` 前缀）—— `release.yml` 里 `TAG="${GITHUB_REF_NAME#v}"` 两者都兼容，但历史 tag 无前缀，保持一致。
- 提交信息用中文写清「为什么」，正文按条列改动；一个提交只做一件事（功能改动与修复分开提交）。
- 推送前 `git status --porcelain` 必须干净，避免把无关的未提交改动混进来。
- 本机 `git push` 会打印 `git-credential-manager.exe: No such file or directory` —— 这是 Scoop 装的 git 缺 GCM，**不影响推送**，看 exit code 和 `550d52b..5ba1819 main -> main` 那行即可。

## Conventions

- Identity = Notion page id (hex32); `state.entries` is the merge base; journal ops (`c`/`m`/`n`/`t`) propagate remote changes between devices.
- Reserved system pages: 🧾 journal, 🗄️ history, ⚙️ config — excluded from vault tree walks and candidate evals.
- Remote "absent from map" = not evaluated (unchanged); deletions are explicit markers.
- Engine writes/renames register in `VaultIO.writes`/`renames` trackers so vault-event listeners can tell engine ops from user ops (auto-sync + rename hints).
- `last_edited_time` is minute-rounded and unreliable — never use it for change detection.
- Modules ~≤300 lines where practical.
