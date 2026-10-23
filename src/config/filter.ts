// Config-dir sync filter — ported from pickpen's selective.ts, config
// categories matching Obsidian's official sync: app, appearance,
// appearance-data, hotkey, core-plugin, core-plugin-data (on by default);
// community-plugin, community-plugin-data (off by default).
// Paths are relative to vault.configDir.

export interface SelectiveConfigSettings {
	app: boolean; // app.json, types.json
	appearance: boolean; // appearance.json
	appearanceData: boolean; // themes/<n>/{theme.css,manifest.json}, snippets/<n>.css
	hotkey: boolean; // hotkeys.json
	corePlugin: boolean; // core-plugins.json, core-plugins-migration.json
	corePluginData: boolean; // other top-level *.json
	communityPlugin: boolean; // community-plugins.json
	communityPluginData: boolean; // plugins/<id>/{manifest.json,main.js,styles.css,data.json}
}

export interface ConfigSyncSettings extends SelectiveConfigSettings {
	enabled: boolean;
}

export function defaultConfigSync(): ConfigSyncSettings {
	return {
		enabled: true,
		app: true,
		appearance: true,
		appearanceData: true,
		hotkey: true,
		corePlugin: true,
		corePluginData: true,
		communityPlugin: false,
		communityPluginData: false,
	};
}

export function anyConfigEnabled(s: ConfigSyncSettings): boolean {
	return (
		s.enabled &&
		(s.app ||
			s.appearance ||
			s.appearanceData ||
			s.hotkey ||
			s.corePlugin ||
			s.corePluginData ||
			s.communityPlugin ||
			s.communityPluginData)
	);
}

const NEVER_FILES = new Set([
	"workspace.json",
	"workspace-mobile.json",
	"sync.json",
]);

/** Our conflict-copy naming: `name (conflict <dev> <ISO>).ext` — local only. */
export function isConflictCopyName(name: string): boolean {
	return / \(conflict [^)]*\)\.[^.]+$/.test(name) || / \(conflict [^)]*\)$/.test(name);
}

function segsOf(rel: string): string[] {
	return rel.split("/").filter((s) => s !== "");
}

function hiddenOrModules(segs: string[]): boolean {
	return segs.some((s) => s === "node_modules" || s.startsWith("."));
}

function extLower(rel: string): string {
	const name = rel.split("/").pop() ?? rel;
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const PLUGIN_FILES = new Set([
	"manifest.json",
	"main.js",
	"styles.css",
	"data.json",
]);

/** rel (relative to configDir) is syncable under settings `c`; `selfId` =
 * our own plugin id — its dir holds the token + sync state, never syncs. */
export function configFileAllowed(
	rel: string,
	c: SelectiveConfigSettings,
	selfId: string,
): boolean {
	const segs = segsOf(rel);
	if (segs.length === 0 || hiddenOrModules(segs)) return false;
	const name = segs[segs.length - 1]!;
	if (isConflictCopyName(name)) return false;
	if (segs.length === 1 && NEVER_FILES.has(name)) return false;
	if (segs[0] === "plugins" && segs[1] === selfId) return false;

	if (rel === "app.json" || rel === "types.json") return c.app;
	if (rel === "appearance.json") return c.appearance;
	if (rel === "hotkeys.json") return c.hotkey;
	if (rel === "core-plugins.json" || rel === "core-plugins-migration.json") {
		return c.corePlugin;
	}
	if (rel === "community-plugins.json") return c.communityPlugin;
	if (
		segs[0] === "themes" &&
		segs.length === 3 &&
		(name === "theme.css" || name === "manifest.json")
	) {
		return c.appearanceData;
	}
	if (segs[0] === "snippets" && segs.length === 2 && extLower(rel) === "css") {
		return c.appearanceData;
	}
	if (segs.length === 1 && extLower(rel) === "json") return c.corePluginData;
	if (segs[0] === "plugins" && segs.length === 3 && PLUGIN_FILES.has(name)) {
		return c.communityPluginData;
	}
	return false;
}

/** Whether a directory inside configDir is worth descending into. */
export function descendAllowed(
	relDir: string,
	c: SelectiveConfigSettings,
	selfId: string,
): boolean {
	const segs = segsOf(relDir);
	if (hiddenOrModules(segs)) return false;
	if (segs.length === 0) return true;
	if (segs[0] === "themes") return c.appearanceData && segs.length < 3;
	if (segs[0] === "snippets") return c.appearanceData && segs.length < 2;
	if (segs[0] === "plugins") {
		return (
			c.communityPluginData && segs.length < 3 && segs[1] !== selfId
		);
	}
	return false;
}
