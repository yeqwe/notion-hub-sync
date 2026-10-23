import { getLanguage, moment } from "obsidian";

export type SupportedLocale = "en" | "zh-CN";

export interface I18nStrings {
	integrationToken: string;
	integrationTokenDescription: string;
	rootPage: string;
	rootPageDescription: string;
	rootPagePlaceholder: string;
	testConnection: string;
	testingConnection: string;
	connectionSuccess(botName: string, pageTitle: string): string;
	missingToken: string;
	missingRootPage: string;
	invalidRootPage: string;
	invalidToken: string;
	rootPageNotFound: string;
	connectionFailed(message: string): string;
	commandTestConnection: string;
	commandSyncNow: string;
	commandFullSync: string;
	syncStarted: string;
	syncDoneAt(time: string): string;
	syncProgress(done: number, total: number): string;
	syncDone(
		created: number,
		updated: number,
		skipped: number,
		failed: number,
	): string;
	settingsHistory: string;
	settingsHistoryDescription: string;
	settingsHistoryInterval: string;
	settingsHistoryIntervalDescription: string;
	settingsHistoryMaxVersions: string;
	settingsHistoryRetentionDays: string;
	settingsFullAuditHours: string;
	settingsFullAuditHoursDescription: string;
	settingsConfigSync: string;
	settingsConfigSyncDescription: string;
	configCatApp: string;
	configCatAppearance: string;
	configCatAppearanceData: string;
	configCatHotkey: string;
	configCatCorePlugin: string;
	configCatCorePluginData: string;
	configCatCommunityPlugin: string;
	configCatCommunityPluginData: string;
	configCommunityDataWarning: string;
	configReloadNotice: string;
	configReloadButton: string;
	commandShowHistory: string;
	commandDeletedFiles: string;
	menuVersionHistory: string;
	historyNotSynced: string;
	historyLoading: string;
	historyEmpty: string;
	historyLoadMore: string;
	historyBinary: string;
	historyCopy: string;
	historyCopied: string;
	historyDiff: string;
	historyRestore: string;
	historyRestoreConfirm(path: string): string;
	historyRestoreConfirmButton: string;
	historyRestoreCancel: string;
	historyRestored: string;
	historyVersionLoadFailed(message: string): string;
	historySelectVersion: string;
	deletedFilesTitle: string;
	deletedFilesEmpty: string;
	deletedFilesRestore: string;
	deletedFilesRestored: string;
	deletedFilesPathTaken(newPath: string): string;
	historyBack: string;
	reasonPush: string;
	reasonPrePull: string;
	reasonPreDelete: string;
	reasonRestore: string;
	settingsAutoSync: string;
	settingsAutoSyncDescription: string;
	settingsAutoSyncDebounce: string;
	settingsAutoSyncDebounceDescription: string;
	settingsAutoSyncInterval: string;
	settingsAutoSyncIntervalDescription: string;
	settingsSyncOnStartup: string;
	settingsSyncOnStartupDescription: string;
	settingsSyncOnForeground: string;
	settingsSyncOnForegroundDescription: string;
	settingsMaxFileSize: string;
	settingsMaxFileSizeDescription: string;
	commandShowStatus: string;
	statusTitle: string;
	statusLastSync(time: string): string;
	statusNever: string;
	statusConflicts(count: number): string;
	statusNoConflicts: string;
	statusFailures: string;
	statusWarnings: string;
	statusOpen: string;
	statusDelete: string;
	statusDeleted: string;
	statusRunning: string;
	statusTipIdle(time: string): string;
	statusTipConflicts(count: number): string;
	statusTipFailed: string;
	conflictNotice(count: number): string;
	blockedNotice(count: number): string;
	panelTitle: string;
	commandOpenPanel: string;
	panelReady: string;
	panelSyncing: string;
	panelError: string;
	panelLastSync: string;
	statCreated: string;
	statUpdated: string;
	statSkipped: string;
	statFailed: string;
	panelConflicts(count: number): string;
	panelLogTitle: string;
	logFilterAll: string;
	logFilterInfo: string;
	logFilterSuccess: string;
	logFilterWarn: string;
	logFilterError: string;
	logClear: string;
	logEmpty: string;
	logOpenPath(path: string): string;
	logPathMissing(path: string): string;
	logRoundStarted(trigger: string): string;
	logRoundFailed(message: string): string;
	logConflictCopy(path: string): string;
	logBlocked(path: string): string;
	triggerManual: string;
	triggerFull: string;
	triggerAuto: string;
	panelGridFull: string;
	panelGridStatus: string;
	panelGridHistory: string;
	panelGridDeleted: string;
	settingsLanguage: string;
	settingsLanguageDescription: string;
	languageAuto: string;
	phaseScanLocal: string;
	phaseScanRemote: string;
	phasePlan(count: number): string;
	phasePlanEmpty: string;
	phaseConfig: string;
	phaseJournal: string;
	actionVerb(type: string): string;
	logActionFailed(verb: string, path: string, error: string): string;
	logUploadPart(part: number, parts: number, path: string): string;
	logUploaded(path: string, size: string): string;
	scanWalked(done: number): string;
	scanHashed(done: number, total: number): string;
	scanEvaluating(done: number, total: number): string;
	settingsDeleteGuard: string;
	settingsDeleteGuardDescription: string;
	deleteGuardTitle: string;
	deleteGuardText(count: number): string;
	deleteGuardMore(count: number): string;
	deleteGuardDelete: string;
	deleteGuardKeep: string;
	deleteGuardCancel: string;
	logGuardDeleted(count: number): string;
	logGuardKept(count: number): string;
	logGuardCancelled(count: number): string;
	commandResetState: string;
	commandReupload: string;
	noticeSyncBusy: string;
	confirmProceed: string;
	confirmCancel: string;
	confirmResetStateText: string;
	confirmReuploadText: string;
	logResetState: string;
	logStateUnreadable(kind: string, bytes: number, detail: string): string;
	logStateQuarantined(path: string): string;
	logStateUnreadableAgain: string;
	confirmQuarantineText: string;
	confirmQuarantineOk: string;
	logClearRemote(count: number): string;
}

const EN_STRINGS: I18nStrings = {
	integrationToken: "Integration token",
	integrationTokenDescription:
		"Paste your Notion internal integration token.",
	rootPage: "Root page",
	rootPageDescription:
		"Notion page used as the sync root. Share it with your integration via Connections.",
	rootPagePlaceholder: "Notion page URL or ID",
	testConnection: "Test connection",
	testingConnection: "Testing connection...",
	connectionSuccess: (botName, pageTitle) =>
		`Connected as ${botName}. Root page: ${pageTitle || "untitled"}.`,
	missingToken: "Configure a Notion integration token first.",
	missingRootPage: "Configure a root page first.",
	invalidRootPage: "Root page is not a valid Notion URL or ID.",
	invalidToken: "Integration token is invalid.",
	rootPageNotFound:
		"Root page not found or not shared with the integration (page menu → Connections).",
	connectionFailed: (message) => `Connection failed: ${message}`,
	commandTestConnection: "Test connection",
	commandSyncNow: "Sync now",
	commandFullSync: "Full sync (check everything)",
	syncStarted: "Syncing...",
	syncDoneAt: (time) => `NHS ✓ ${time}`,
	syncProgress: (done, total) => `${done}/${total}`,
	syncDone: (created, updated, skipped, failed) =>
		`Done: ${created} created, ${updated} updated, ${skipped} skipped, ${failed} failed.`,
	settingsHistory: "Version history",
	settingsHistoryDescription:
		"Keep per-file versions in Notion (pushes, pre-pull snapshots, restores).",
	settingsHistoryInterval: "Push version interval (minutes)",
	settingsHistoryIntervalDescription:
		"Minimum minutes between push versions of the same file.",
	settingsHistoryMaxVersions: "Max versions per file",
	settingsHistoryRetentionDays: "Version retention (days)",
	settingsFullAuditHours: "Full audit interval (hours)",
	settingsFullAuditHoursDescription:
		"How often sync re-walks the whole Notion tree to catch missed changes.",
	settingsConfigSync: "Sync Obsidian settings",
	settingsConfigSyncDescription:
		"Sync selected .obsidian config files through Notion (per device).",
	configCatApp: "App settings",
	configCatAppearance: "Appearance",
	configCatAppearanceData: "Themes and snippets",
	configCatHotkey: "Hotkeys",
	configCatCorePlugin: "Core plugins",
	configCatCorePluginData: "Core plugin settings",
	configCatCommunityPlugin: "Installed community plugins",
	configCatCommunityPluginData: "Community plugin settings",
	configCommunityDataWarning:
		"Plugin data.json may contain API keys — stored in plaintext in Notion.",
	configReloadNotice:
		"Settings updated from another device — reload to apply.",
	configReloadButton: "Reload",
	commandShowHistory: "Show version history of current file",
	commandDeletedFiles: "Show deleted files (recoverable)",
	menuVersionHistory: "Version history",
	historyNotSynced: "This file has not been synced yet.",
	historyLoading: "Loading version history…",
	historyEmpty: "No versions recorded yet.",
	historyLoadMore: "Load more",
	historyBinary: "Binary content — cannot preview (restorable).",
	historyCopy: "Copy",
	historyCopied: "Version content copied.",
	historyDiff: "Diff vs current",
	historyRestore: "Restore this version",
	historyRestoreConfirm: (path) =>
		`Overwrite ${path} with this version? The current content is kept as a version.`,
	historyRestoreConfirmButton: "Confirm restore",
	historyRestoreCancel: "Cancel",
	historyRestored: "Restored — will sync to Notion on next push.",
	historyVersionLoadFailed: (message) =>
		`Failed to load version: ${message}`,
	historySelectVersion: "Select a version on the left",
	deletedFilesTitle: "Deleted files (recoverable)",
	deletedFilesEmpty: "No recoverable deleted files.",
	deletedFilesRestore: "Restore",
	deletedFilesRestored: "File restored.",
	deletedFilesPathTaken: (newPath) =>
		`Path taken — restored as ${newPath} instead.`,
	historyBack: "← Back",
	reasonPush: "push",
	reasonPrePull: "pre-pull",
	reasonPreDelete: "pre-delete",
	reasonRestore: "restore",
	settingsAutoSync: "Automatic sync",
	settingsAutoSyncDescription:
		"Sync automatically on vault changes, on an interval, on startup, and when the app returns to the foreground.",
	settingsAutoSyncDebounce: "Change debounce (seconds)",
	settingsAutoSyncDebounceDescription:
		"Wait this long after the last vault change before syncing.",
	settingsAutoSyncInterval: "Sync interval (minutes)",
	settingsAutoSyncIntervalDescription:
		"Periodic sync interval. 0 disables interval sync.",
	settingsSyncOnStartup: "Sync on startup",
	settingsSyncOnStartupDescription:
		"Run a sync shortly after Obsidian starts.",
	settingsSyncOnForeground: "Sync on foreground",
	settingsSyncOnForegroundDescription:
		"Sync when the app becomes visible again (mobile foreground).",
	settingsMaxFileSize: "Max file size (MB)",
	settingsMaxFileSizeDescription:
		"Files larger than this are skipped and reported as blocked.",
	commandShowStatus: "Show sync status",
	statusTitle: "Sync status",
	statusLastSync: (time) => `Last sync: ${time}`,
	statusNever: "never",
	statusConflicts: (count) => `${count} conflict cop${count === 1 ? "y" : "ies"} in vault:`,
	statusNoConflicts: "No conflict copies in the vault.",
	statusFailures: "Failures",
	statusWarnings: "Warnings",
	statusOpen: "Open",
	statusDelete: "Delete",
	statusDeleted: "Moved to trash.",
	statusRunning: "Syncing…",
	statusTipIdle: (time) => `Notion Hub Sync — last sync ${time}`,
	statusTipConflicts: (count) =>
		`Notion Hub Sync — ${count} unresolved conflict${count === 1 ? "" : "s"}`,
	statusTipFailed: "Notion Hub Sync — last sync had failures",
	conflictNotice: (count) =>
		`${count} conflict cop${count === 1 ? "y" : "ies"} created — see sync status.`,
	blockedNotice: (count) =>
		`${count} file${count === 1 ? "" : "s"} blocked (too large).`,
	panelTitle: "Notion sync",
	commandOpenPanel: "Open sync panel",
	panelReady: "Ready",
	panelSyncing: "Syncing",
	panelError: "Error",
	panelLastSync: "Last sync",
	statCreated: "Created",
	statUpdated: "Updated",
	statSkipped: "Skipped",
	statFailed: "Failed",
	panelConflicts: (count) => `${count} conflict cop${count === 1 ? "y" : "ies"}`,
	panelLogTitle: "Log",
	logFilterAll: "All",
	logFilterInfo: "Info",
	logFilterSuccess: "Success",
	logFilterWarn: "Warn",
	logFilterError: "Error",
	logClear: "Clear",
	logEmpty: "No log entries yet.",
	logOpenPath: (path) => `Open ${path}`,
	logPathMissing: (path) => `Not found in this vault: ${path}`,
	logRoundStarted: (trigger) => `Sync round started (${trigger})`,
	logRoundFailed: (message) => `Sync failed: ${message}`,
	logConflictCopy: (path) => `Conflict copy: ${path}`,
	logBlocked: (path) => `Blocked (too large): ${path}`,
	triggerManual: "manual",
	triggerFull: "full",
	triggerAuto: "auto",
	panelGridFull: "Full sync",
	panelGridStatus: "Conflicts",
	panelGridHistory: "History",
	panelGridDeleted: "Deleted",
	settingsLanguage: "Language",
	settingsLanguageDescription:
		"Interface language. Auto follows Obsidian's own language setting.",
	languageAuto: "Auto (follow Obsidian)",
	phaseScanLocal: "Scanning local files…",
	phaseScanRemote: "Fetching Notion changes…",
	phasePlan: (count) =>
		`Planned ${count} operation${count === 1 ? "" : "s"}`,
	phasePlanEmpty: "Nothing to sync",
	phaseConfig: "Syncing Obsidian settings…",
	phaseJournal: "Writing change journal…",
	actionVerb: (type) =>
		({
			createRemoteFolder: "Create folder in Notion",
			createLocalFolder: "Create local folder",
			pushNew: "Upload new file",
			pullNew: "Download new file",
			pushContent: "Upload changes",
			pullContent: "Download changes",
			merge: "Merge changes",
			conflictCopy: "Create conflict copy",
			localConflictCopy: "Create conflict copy",
			moveRemote: "Move/rename in Notion",
			moveLocal: "Move/rename locally",
			trashRemote: "Delete Notion page",
			trashLocal: "Delete local file",
			recreateRemote: "Recreate Notion page",
			restoreLocal: "Restore local file",
		})[type] ?? type,
	logActionFailed: (verb, path, error) =>
		`${verb} ${path} failed: ${error}`,
	logUploadPart: (part, parts, path) =>
		`Upload part ${part}/${parts}: ${path}`,
	logUploaded: (path, size) => `Uploaded ${path} (${size})`,
	scanWalked: (done) => `Walked ${done} Notion pages`,
	scanHashed: (done, total) => `Hashing local files ${done}/${total}`,
	scanEvaluating: (done, total) =>
		`Checking Notion pages ${done}/${total}`,
	settingsDeleteGuard: "Bulk delete guard threshold",
	settingsDeleteGuardDescription:
		"Ask for confirmation before a sync round deletes at least this many local files (0 = off).",
	deleteGuardTitle: "Confirm local file deletion",
	deleteGuardText: (count) =>
		`Notion deleted the following ${count} file${count === 1 ? "" : "s"}. Syncing will move them to the local trash too.`,
	deleteGuardMore: (count) => `…and ${count} more`,
	deleteGuardDelete: "Delete local files",
	deleteGuardKeep: "Keep and re-upload to Notion",
	deleteGuardCancel: "Cancel this sync",
	logGuardDeleted: (count) =>
		`Delete guard: user confirmed deleting ${count} local files`,
	logGuardKept: (count) =>
		`Delete guard: keeping ${count} local files, re-uploading`,
	logGuardCancelled: (count) =>
		`Delete guard: sync cancelled — ${count} local deletions not confirmed`,
	commandResetState: "Reset sync record (re-match)",
	commandReupload: "Clear Notion and re-upload from local",
	noticeSyncBusy: "A sync is already running.",
	confirmProceed: "Proceed",
	confirmCancel: "Cancel",
	confirmResetStateText:
		"This clears only this device's sync record. The next sync re-matches local files with Notion pages by path — identical content links, different content creates conflict copies.",
	confirmReuploadText:
		"ALL pages under the Notion root page (including version history) will be moved to the Notion trash (recoverable for 30 days), then the whole vault is uploaded again. Other devices must run \"Reset sync record (re-match)\" afterwards — if they show the bulk-delete prompt, they should choose \"Cancel this sync\" first.",
	logResetState:
		"Sync record reset — next sync re-matches by path.",
	logStateUnreadable: (kind, bytes, detail) =>
		`Sync state unreadable (${kind}, ${bytes} bytes: ${detail}) — this round was skipped instead of re-downloading the whole vault. Run "Reset sync record" to start over.`,
	logStateQuarantined: (path) => `Unreadable sync state kept as ${path}`,
	logStateUnreadableAgain:
		"Sync state is still unreadable — see the log line above for the exact error.",
	confirmQuarantineText:
		"The sync record could not be read, which makes every round re-download the whole vault. Rename the damaged file (kept for inspection) and re-match against the existing Notion pages?",
	confirmQuarantineOk: "Rename and re-match",
	logClearRemote: (count) =>
		`Moved ${count} Notion page${count === 1 ? "" : "s"} to trash.`,
};

const ZH_CN_STRINGS: I18nStrings = {
	integrationToken: "集成令牌",
	integrationTokenDescription: "粘贴你的 Notion 内部集成令牌。",
	rootPage: "根页面",
	rootPageDescription:
		"用作同步根节点的 Notion 页面，需通过 Connections 共享给你的集成。",
	rootPagePlaceholder: "Notion 页面链接或 ID",
	testConnection: "测试连接",
	testingConnection: "正在测试连接...",
	connectionSuccess: (botName, pageTitle) =>
		`已连接为 ${botName}。根页面：${pageTitle || "未命名"}。`,
	missingToken: "请先配置 Notion 集成令牌。",
	missingRootPage: "请先配置根页面。",
	invalidRootPage: "根页面不是有效的 Notion 链接或 ID。",
	invalidToken: "集成令牌无效。",
	rootPageNotFound:
		"找不到根页面，或页面未共享给集成（页面菜单 → Connections）。",
	connectionFailed: (message) => `连接失败：${message}`,
	commandTestConnection: "测试连接",
	commandSyncNow: "立即同步",
	commandFullSync: "完整同步（检查全部）",
	syncStarted: "正在同步...",
	syncDoneAt: (time) => `NHS ✓ ${time}`,
	syncProgress: (done, total) => `${done}/${total}`,
	syncDone: (created, updated, skipped, failed) =>
		`完成：新建 ${created}，更新 ${updated}，跳过 ${skipped}，失败 ${failed}。`,
	settingsHistory: "版本历史",
	settingsHistoryDescription:
		"在 Notion 中为每个文件保留版本（推送、拉取前快照、恢复）。",
	settingsHistoryInterval: "推送版本间隔（分钟）",
	settingsHistoryIntervalDescription: "同一文件两次推送版本之间的最小分钟数。",
	settingsHistoryMaxVersions: "每个文件的最大版本数",
	settingsHistoryRetentionDays: "版本保留天数",
	settingsFullAuditHours: "完整检查间隔（小时）",
	settingsFullAuditHoursDescription:
		"每隔多久重新遍历整个 Notion 树，捕捉遗漏的变更。",
	settingsConfigSync: "同步 Obsidian 设置",
	settingsConfigSyncDescription:
		"通过 Notion 同步选定的 .obsidian 配置文件（按设备生效）。",
	configCatApp: "应用设置",
	configCatAppearance: "外观",
	configCatAppearanceData: "主题与代码片段",
	configCatHotkey: "快捷键",
	configCatCorePlugin: "核心插件",
	configCatCorePluginData: "核心插件设置",
	configCatCommunityPlugin: "已安装的第三方插件",
	configCatCommunityPluginData: "第三方插件设置",
	configCommunityDataWarning:
		"第三方插件的 data.json 可能包含 API key 等敏感信息，会以明文保存在 Notion 中。",
	configReloadNotice: "设置已从其他设备更新，重新加载 Obsidian 后生效。",
	configReloadButton: "重新加载",
	commandShowHistory: "显示当前文件的版本历史",
	commandDeletedFiles: "显示已删除的文件（可恢复）",
	menuVersionHistory: "版本历史",
	historyNotSynced: "该文件尚未同步。",
	historyLoading: "正在加载版本历史…",
	historyEmpty: "暂无版本记录。",
	historyLoadMore: "加载更多",
	historyBinary: "二进制内容，无法预览（仍可恢复）。",
	historyCopy: "复制内容",
	historyCopied: "已复制该版本内容。",
	historyDiff: "对比当前",
	historyRestore: "恢复此版本",
	historyRestoreConfirm: (path) =>
		`将用此版本覆盖 ${path}？当前内容会保留为一个版本。`,
	historyRestoreConfirmButton: "确认恢复",
	historyRestoreCancel: "取消",
	historyRestored: "已恢复，下次推送时同步到 Notion。",
	historyVersionLoadFailed: (message) => `版本加载失败：${message}`,
	historySelectVersion: "选择左侧版本查看内容",
	deletedFilesTitle: "已删除的文件（可恢复）",
	deletedFilesEmpty: "没有可恢复的已删除文件。",
	deletedFilesRestore: "恢复",
	deletedFilesRestored: "已恢复该文件。",
	deletedFilesPathTaken: (newPath) => `路径已被占用，恢复为 ${newPath}。`,
	historyBack: "← 返回",
	reasonPush: "推送",
	reasonPrePull: "拉取前",
	reasonPreDelete: "删除前",
	reasonRestore: "恢复",
	settingsAutoSync: "自动同步",
	settingsAutoSyncDescription:
		"在文件变更、定时、启动和应用回到前台时自动同步。",
	settingsAutoSyncDebounce: "变更防抖（秒）",
	settingsAutoSyncDebounceDescription: "最后一次文件变更后等待这么久再同步。",
	settingsAutoSyncInterval: "同步间隔（分钟）",
	settingsAutoSyncIntervalDescription: "定时同步间隔，0 表示关闭。",
	settingsSyncOnStartup: "启动时同步",
	settingsSyncOnStartupDescription: "Obsidian 启动后不久运行一次同步。",
	settingsSyncOnForeground: "回到前台时同步",
	settingsSyncOnForegroundDescription: "应用重新可见时同步（移动端前台）。",
	settingsMaxFileSize: "最大文件大小（MB）",
	settingsMaxFileSizeDescription: "超过此大小的文件将被跳过并标记为受阻。",
	commandShowStatus: "显示同步状态",
	statusTitle: "同步状态",
	statusLastSync: (time) => `上次同步：${time}`,
	statusNever: "从未同步",
	statusConflicts: (count) => `库中有 ${count} 个冲突副本：`,
	statusNoConflicts: "库中没有冲突副本。",
	statusFailures: "失败",
	statusWarnings: "警告",
	statusOpen: "打开",
	statusDelete: "删除",
	statusDeleted: "已移入回收站。",
	statusRunning: "同步中…",
	statusTipIdle: (time) => `Notion Hub Sync — 上次同步 ${time}`,
	statusTipConflicts: (count) => `Notion Hub Sync — ${count} 个未解决冲突`,
	statusTipFailed: "Notion Hub Sync — 上次同步有失败",
	conflictNotice: (count) => `产生了 ${count} 个冲突副本 — 请查看同步状态。`,
	blockedNotice: (count) => `${count} 个文件被跳过（超出大小限制）。`,
	panelTitle: "Notion 同步",
	commandOpenPanel: "打开同步面板",
	panelReady: "就绪",
	panelSyncing: "同步中",
	panelError: "错误",
	panelLastSync: "上次同步",
	statCreated: "新建",
	statUpdated: "更新",
	statSkipped: "跳过",
	statFailed: "失败",
	panelConflicts: (count) => `${count} 个冲突副本`,
	panelLogTitle: "日志",
	logFilterAll: "全部",
	logFilterInfo: "信息",
	logFilterSuccess: "成功",
	logFilterWarn: "警告",
	logFilterError: "错误",
	logClear: "清空",
	logEmpty: "暂无日志。",
	logOpenPath: (path) => `打开 ${path}`,
	logPathMissing: (path) => `本地找不到该文件：${path}`,
	logRoundStarted: (trigger) => `同步轮次开始（${trigger}）`,
	logRoundFailed: (message) => `同步失败：${message}`,
	logConflictCopy: (path) => `冲突副本：${path}`,
	logBlocked: (path) => `已跳过（超出大小限制）：${path}`,
	triggerManual: "手动",
	triggerFull: "完整",
	triggerAuto: "自动",
	panelGridFull: "完整同步",
	panelGridStatus: "冲突",
	panelGridHistory: "历史版本",
	panelGridDeleted: "已删除",
	settingsLanguage: "界面语言",
	settingsLanguageDescription:
		"插件界面语言。“自动”跟随 Obsidian 自身的语言设置。",
	languageAuto: "自动（跟随 Obsidian）",
	phaseScanLocal: "扫描本地文件…",
	phaseScanRemote: "获取 Notion 端变更…",
	phasePlan: (count) => `计划执行 ${count} 项操作`,
	phasePlanEmpty: "没有需要同步的变更",
	phaseConfig: "同步 Obsidian 设置…",
	phaseJournal: "写入变更日志…",
	actionVerb: (type) =>
		({
			createRemoteFolder: "在 Notion 创建文件夹",
			createLocalFolder: "在本地创建文件夹",
			pushNew: "上传新文件",
			pullNew: "下载新文件",
			pushContent: "上传修改",
			pullContent: "下载修改",
			merge: "合并修改",
			conflictCopy: "生成冲突副本",
			localConflictCopy: "生成冲突副本",
			moveRemote: "Notion 端移动/重命名",
			moveLocal: "本地移动/重命名",
			trashRemote: "删除 Notion 页面",
			trashLocal: "删除本地文件",
			recreateRemote: "重建 Notion 页面",
			restoreLocal: "恢复本地文件",
		})[type] ?? type,
	logActionFailed: (verb, path, error) =>
		`${verb} ${path} 失败：${error}`,
	logUploadPart: (part, parts, path) =>
		`上传分片 ${part}/${parts}：${path}`,
	logUploaded: (path, size) => `已上传 ${path}（${size}）`,
	scanWalked: (done) => `已遍历 ${done} 个 Notion 页面`,
	scanHashed: (done, total) => `计算本地文件哈希 ${done}/${total}`,
	scanEvaluating: (done, total) =>
		`检查 Notion 页面 ${done}/${total}`,
	settingsDeleteGuard: "批量删除保护阈值",
	settingsDeleteGuardDescription:
		"一轮同步要删除的本地文件数达到此值时先弹窗确认（0 = 关闭）",
	deleteGuardTitle: "确认删除本地文件",
	deleteGuardText: (count) =>
		`Notion 端删除了以下 ${count} 个文件。同步会把它们在本地也移到回收站。`,
	deleteGuardMore: (count) => `…等 ${count} 个`,
	deleteGuardDelete: "删除本地文件",
	deleteGuardKeep: "保留并重新上传到 Notion",
	deleteGuardCancel: "取消本次同步",
	logGuardDeleted: (count) =>
		`删除保护：已确认删除 ${count} 个本地文件`,
	logGuardKept: (count) =>
		`删除保护：保留 ${count} 个本地文件并重新上传`,
	logGuardCancelled: (count) =>
		`删除保护：已取消同步，${count} 个本地删除未执行`,
	commandResetState: "重置同步记录（重新匹配）",
	commandReupload: "清空 Notion 并从本地重新上传",
	noticeSyncBusy: "同步进行中，请稍后再试。",
	confirmProceed: "继续",
	confirmCancel: "取消",
	confirmResetStateText:
		"只会清空本设备的同步记录；下次同步会按路径把本地文件与 Notion 页面重新匹配（内容相同的直接关联，不同的会生成冲突副本）。",
	confirmReuploadText:
		"Notion 根页面下的全部页面（包括版本历史）会被移入 Notion 回收站（30 天内可恢复），然后重新上传整个仓库。其他设备之后需要运行「重置同步记录（重新匹配）」；如果它们弹出批量删除确认，请先选择「取消本次同步」。",
	logResetState: "同步记录已重置，下次同步按路径重新匹配。",
	logStateUnreadable: (kind, bytes, detail) =>
		`同步记录无法读取（${kind}，${bytes} 字节：${detail}）——本轮已跳过，不会重新下载整个库。如需从头开始，请执行「重置同步记录」。`,
	logStateQuarantined: (path) => `无法读取的同步记录已改名保留为 ${path}`,
	logStateUnreadableAgain:
		"同步记录仍然无法读取——具体原因见上一条日志。",
	confirmQuarantineText:
		"同步记录文件无法读取，这会让每轮同步都重新下载整个库。是否把损坏的文件改名保留（便于排查），并按 Notion 现有页面重新匹配？",
	confirmQuarantineOk: "改名保留并重新匹配",
	logClearRemote: (count) => `已将 ${count} 个 Notion 页面移入回收站`,
};

export function resolveLocale(language: string | undefined): SupportedLocale {
	if (!language) {
		return "en";
	}
	return language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function detectLanguage(): string | undefined {
	// Obsidian ≥ 1.8.7 exposes the app language directly. `localStorage
	// ["language"]` (the old trick) stopped being maintained and is empty
	// on mobile — that is why the UI fell back to English on iOS.
	try {
		const lang = getLanguage();
		if (lang) return lang;
	} catch {
		// API older than 1.8.7: fall through to the next source.
	}
	try {
		const loc = moment?.locale?.();
		if (loc) return loc;
	} catch {
		// moment unavailable in this environment.
	}
	try {
		if (typeof window !== "undefined" && window.localStorage) {
			return window.localStorage.getItem("language") ?? undefined;
		}
	} catch {
		// localStorage may be unavailable; fall back to English.
	}
	return undefined;
}

/** Explicit language choice from settings; null = follow Obsidian. */
let overriddenLocale: SupportedLocale | null = null;

/** `"auto"` clears the override and resumes detection. */
export function setOverriddenLocale(value: string | undefined): void {
	overriddenLocale =
		value === undefined || value === "" || value === "auto"
			? null
			: resolveLocale(value);
}

export function getStrings(language?: string): I18nStrings {
	const lang = language ?? overriddenLocale ?? detectLanguage();
	return resolveLocale(lang) === "zh-CN" ? ZH_CN_STRINGS : EN_STRINGS;
}
