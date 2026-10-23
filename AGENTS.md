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

### 代理（本机必读）

- **命令行默认不走代理**：浏览器能开 github.com，但 `git` / `curl` 直连 443 会 `Connection was reset` 或 `Failed to connect to github.com port 443 after 21s`。DNS 解析正常、`Invoke-WebRequest https://github.com` 也能返回 200，所以「网络看着是通的」并不说明 git 能推。
- **代理地址：`http://127.0.0.1:10808`**（本机 Clash 系客户端）。推送前设置环境变量：

```powershell
$env:HTTPS_PROXY='http://127.0.0.1:10808'; $env:HTTP_PROXY='http://127.0.0.1:10808'
git push origin main; git push origin <tag>
```

- 判断依据：`git push` 报 `Recv failure: Connection was reset` 或 `Could not connect to server` → 先加代理重试，不要怀疑仓库或凭据。
- 不想每次设环境变量，可持久化（全局，影响所有仓库）：

```powershell
git config --global http.proxy http://127.0.0.1:10808
git config --global https.proxy http://127.0.0.1:10808
```

- `npm test` / `npm run build` / `npm run test:live` **不需要**代理（Notion API 直连可达）。

## Conventions

- Identity = Notion page id (hex32); `state.entries` is the merge base; journal ops (`c`/`m`/`n`/`t`) propagate remote changes between devices.
- Reserved system pages: 🧾 journal, 🗄️ history, ⚙️ config — excluded from vault tree walks and candidate evals.
- Remote "absent from map" = not evaluated (unchanged); deletions are explicit markers.
- Engine writes/renames register in `VaultIO.writes`/`renames` trackers so vault-event listeners can tell engine ops from user ops (auto-sync + rename hints).
- `last_edited_time` is minute-rounded and unreliable — never use it for change detection.
- **转换必须幂等**：`obsidianToNotion` → `notionToObsidian` 必须回到同一份文本。不幂等 = 引擎每轮都判定「远端变了」→ 反复下载用户没改过的笔记，并在历史里堆无意义的 pre-pull 版本。改动 `src/convert/` 后跑 `src/convert/idempotency.test.ts`。
- **不要按行解析 HTML 块**：从网页粘贴的表格是单行 `<table><tr><td>…</table>`，按行找 `</table>` 永远找不到，表格内容会被整块丢弃且闭合标签泄进正文。统一走 `src/convert/html-table.ts`（按标签结构/深度解析）。
- **不认识的块宁可丢弃，不要转义后写回**：`\<table\>` 这类转义文本在 Notion 端看起来像内容，会永久存活并制造死循环。
- 路径归一化：磁盘路径进引擎前一律 `normalizeVaultPath`（NFC）。macOS 返回 NFD，Notion 返回 NFC；不归一化会把未改动的文件判为「本地已删除」并 trash 远端页面。
- 写盘一律 `writeVerified` / `writeTextVerified`（临时文件 → 读回校验 → 落位）。截断的 Markdown 还能打开，不做校验就永远不会被发现。
- `sanitizeTitle` 只管标题；保留设备名（`CON`/`nul`/`COM1`…）用 `safeFileName`，且只在真正生成磁盘路径时应用——放进 `sanitizeTitle` 会让 `nameFor` 派生的标题与 base 记录不匹配，制造每轮重命名。
- Modules ~≤300 lines where practical.
