# Notion Hub Sync

通过 Notion 在多台设备之间同步你的整个 Obsidian 仓库 —— 无需 Obsidian Sync 订阅，桌面与移动端（iOS/Android）均可使用。Notion 作为中转枢纽：你的笔记被保存为一棵 Notion 页面树，任何一台设备改动后，其他设备在下一轮同步时拉取更新。

## 功能

- **全库双向同步**：笔记、附件（图片/PDF/音视频/任意文件）与文件夹结构。
- **增量三方合并**：本地改动、远端改动、合并基准三者对比；同一份文件两端同时编辑时按行合并（git merge 风格），真正冲突时保留冲突副本，不丢任何一方内容。
- **删除与重命名**：删除会在另一端移入回收站；重命名/移动通过提示 + 指纹检测传播，不会整树重传。
- **Obsidian 设置同步**（可选，按设备配置）：`appearance.json`、快捷键、主题/代码片段、插件配置等 `.obsidian` 配置文件，同样走 Notion 同步。冲突时远端生效，本地版本保留为本地冲突副本。
- **版本历史与找回已删除文件**：每次推送/覆盖/删除前都在 Notion 中保留版本，可随时预览、对比、恢复。
- **自动同步**：文件变更防抖、定时间隔、启动时、回到前台时（移动端）自动触发；手动命令仍然可用。
- **大文件**：超过 20 MiB 的文件自动使用 Notion 多段上传。

## 安装

### 方式一：BRAT（推荐，桌面 + 手机）

1. 安装社区插件 **BRAT**（Beta Reviewers Auto-update Tester）。
2. 命令面板运行 `BRAT: Add a beta plugin for testing`。
3. 填入本仓库地址：`https://github.com/yeqwe/notion-hub-sync`。
4. 回到社区插件列表，启用 **Notion Hub Sync**。

BRAT 会读取仓库的 GitHub Release（`manifest.json` / `versions.json` / `main.js` / `styles.css`）自动安装与升级。手机端无需手动拷贝文件。

### 方式二：手动安装

从 [Releases](https://github.com/yeqwe/notion-hub-sync/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放入 `<仓库>/.obsidian/plugins/notion-hub-sync/`。

## 设置

1. 在 <https://www.notion.so/my-integrations> 创建一个 **Internal Integration**，复制 token（`ntn_…`）。
2. 在 Notion 中准备一个页面作为**同步根目录**，通过页面右上角 `⋯ → Connections` 把它共享给你的集成。
3. 安装本插件后，在设置里填入 token 和根页面链接/ID，点击「测试连接」。
4. **首次同步前建议先备份仓库**。然后运行命令「立即同步」完成首次全量推送；之后其它设备装同一插件、指向同一根页面即可。

## 同步原理（简述）

- 每台设备本地维护一份同步状态（pageId ↔ 路径、内容哈希、合并基准文本）。
- 仓库在 Notion 中映射为页面树：📁 文件夹 / 无图标为笔记 / 📎 附件；笔记正文是 Markdown，源文无损保存在折叠的 "source" 区块里，Obsidian ↔ Notion 双向往返不丢格式。
- 每次远端变更会写一条**变更日志**（🧾 系统页），其它设备通过日志 + 搜索 + 定期全量巡检发现改动。
- 系统页 🧾 日志、🗄️ 历史、⚙️ 设置不会出现在你的仓库里。

## 命令

| 命令 | 说明 |
| --- | --- |
| 立即同步 | 增量同步一轮 |
| 完整同步（检查全部） | 强制全量巡检（找回日志间隙 / Notion 网页端改动） |
| 显示同步状态 | 上次同步结果、失败项、冲突副本管理 |
| 显示当前文件的版本历史 | 预览 / diff / 恢复 |
| 显示已删除的文件（可恢复） | 从 Notion 历史中找回 |
| 测试连接 | 验证 token 与根页面权限 |
| 重置本设备同步记录 | 清空本地映射，下一轮按路径重新匹配（用于状态损坏时） |
| 清空 Notion 并重新上传 | 将根页面下所有页面移入回收站后用本地内容重建（危险操作，有二次确认） |

## 安全机制

- **批量删除保护**：单轮要删除的本地文件数超过阈值（默认 10，可调）时弹窗确认，可选「保留并重新上传到 Notion」或取消本轮。
- **冲突副本**：合并失败时双方内容都保留，副本不向上传播。
- **覆盖前先存版本**：拉取覆盖本地内容、删除文件前都会先在 Notion 历史里留底。
- **中断可恢复**：每条变更先写日志再执行，中途断网/退出后下一轮自动续做，不会产生重复页面。

## 限制与注意事项

- **Notion 网页端手动编辑**：API 不推送事件，且 `last_edited_time` 按分钟取整（同一分钟内的改动不会改变该字段），所以网页端改动无法保证立即同步。插件每轮会自动重新校验 10 个文件的内容、每 6 小时做一次全量巡检，用轮转覆盖的方式兜底；完整同步命令可强制检查。库越大，最坏发现延迟越长（约「文件数 ÷ 10」轮）。
- **仅 Notion 侧编辑才有的格式损失**：标题 h5/h6 会降为 h4、少量高级语法在 Notion 端没有对应物 —— 由 Obsidian 端推送的内容通过源区块 100% 保留，只在 Notion 端再编辑时才可能降级。
- **设置同步**按设备生效；`workspace.json`、本插件自身配置（含 token）永远不会同步。开启「第三方插件设置」会同步各插件的 `data.json` —— 其中可能包含 API key，会以**明文**存进 Notion。
- 单文件默认上限 200 MB（可调）。
- 多设备同时在线编辑同一文件可能产生冲突副本（原始内容均保留，可在「同步状态」中处理）。

---

## English (short)

Syncs your entire Obsidian vault across devices through a Notion page tree — desktop and mobile, no Obsidian Sync subscription needed.

**Setup**: create a Notion internal integration, share a root page with it, paste token + page link in settings, back up your vault, then run "Sync now". Other devices point at the same root page.

**How it works**: vault → Notion page tree (folders 📁 / notes / attachments 📎); notes keep a lossless source block for round-trip fidelity; a 🧾 change journal + search + periodic full audits propagate edits; per-file history (🗄️) backs every overwrite/delete; optional per-device sync of selected `.obsidian` config files (⚙️).

**Limits**: edits made in the Notion UI are detected best-effort (run "Full sync" to force a check); >20 MiB files use multi-part upload; plugin `data.json` sync is plaintext in Notion (off by default); default per-file cap 200 MB.
