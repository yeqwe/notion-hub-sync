import { describe, expect, it } from "vitest";
import {
	configFileAllowed,
	descendAllowed,
	defaultConfigSync,
	type SelectiveConfigSettings,
} from "./filter";

const SELF = "notion-hub-sync";

function cfg(over: Partial<SelectiveConfigSettings> = {}) {
	return { ...defaultConfigSync(), ...over };
}

describe("configFileAllowed", () => {
	it.each([
		["app.json", true],
		["types.json", true],
		["appearance.json", true],
		["hotkeys.json", true],
		["core-plugins.json", true],
		["core-plugins-migration.json", false], // legacy compat file, app rewrites it
		["dataview.json", true], // corePluginData catch-all
		["community-plugins.json", false], // off by default
		["themes/x/theme.css", true],
		["themes/x/manifest.json", true],
		["themes/x/other.css", false],
		["snippets/a.css", true],
		["snippets/a.js", false],
		["snippets/sub/a.css", false],
		["plugins/dataview/data.json", false], // communityPluginData off
		["plugins/dataview/main.js", false], // communityPlugin off
		["workspace.json", false],
		["workspace-mobile.json", false],
		["sync.json", false],
		[".hidden.json", false],
		["node_modules/x.json", false],
		["plugins/node_modules/x/data.json", false],
		["core-plugins (conflict abc 2026-01-01).json", false],
		["appearance (conflict abc 2026-01-01T00-00-00Z).json", false],
	])("%s → %s", (rel, expected) => {
		expect(configFileAllowed(rel, cfg(), SELF)).toBe(expected);
	});

	it("never syncs our own plugin dir even with communityPluginData on", () => {
		const on = cfg({ communityPluginData: true, communityPlugin: true });
		expect(
			configFileAllowed("plugins/notion-hub-sync/data.json", on, SELF),
		).toBe(false);
		expect(configFileAllowed("plugins/dataview/data.json", on, SELF)).toBe(
			true,
		);
		expect(
			configFileAllowed("plugins/dataview/styles.css", on, SELF),
		).toBe(true);
		expect(configFileAllowed("plugins/dataview/x.json", on, SELF)).toBe(
			false,
		);
		expect(
			configFileAllowed("plugins/dataview/sub/data.json", on, SELF),
		).toBe(false);
	});

	it("communityPlugin syncs the plugin itself, communityPluginData its settings", () => {
		// The label is "Installed community plugins". A device that receives
		// only community-plugins.json knows dataview should be enabled and has
		// no dataview — so the code files answer to communityPlugin.
		const code = cfg({ communityPlugin: true, communityPluginData: false });
		expect(configFileAllowed("community-plugins.json", code, SELF)).toBe(true);
		expect(configFileAllowed("plugins/dataview/manifest.json", code, SELF)).toBe(
			true,
		);
		expect(configFileAllowed("plugins/dataview/main.js", code, SELF)).toBe(true);
		expect(configFileAllowed("plugins/dataview/styles.css", code, SELF)).toBe(
			true,
		);
		expect(configFileAllowed("plugins/dataview/data.json", code, SELF)).toBe(
			false,
		);

		const data = cfg({ communityPlugin: false, communityPluginData: true });
		expect(configFileAllowed("plugins/dataview/data.json", data, SELF)).toBe(
			true,
		);
		expect(configFileAllowed("plugins/dataview/main.js", data, SELF)).toBe(
			false,
		);
	});

	it("category switches gate their files", () => {
		const off = cfg({
			app: false,
			appearance: false,
			appearanceData: false,
			hotkey: false,
			corePlugin: false,
			corePluginData: false,
			communityPlugin: true,
			communityPluginData: true,
		});
		expect(configFileAllowed("app.json", off, SELF)).toBe(false);
		expect(configFileAllowed("appearance.json", off, SELF)).toBe(false);
		expect(configFileAllowed("snippets/a.css", off, SELF)).toBe(false);
		expect(configFileAllowed("hotkeys.json", off, SELF)).toBe(false);
		expect(configFileAllowed("core-plugins.json", off, SELF)).toBe(false);
		expect(configFileAllowed("dataview.json", off, SELF)).toBe(false);
		expect(configFileAllowed("community-plugins.json", off, SELF)).toBe(
			true,
		);
		expect(configFileAllowed("plugins/x/data.json", off, SELF)).toBe(
			true,
		);
	});
});

describe("descendAllowed", () => {
	it.each([
		["themes", true],
		["themes/x", true],
		["themes/x/y", false],
		["snippets", true],
		["snippets/x", false],
		["plugins", false], // communityPluginData off
		["plugins/x", false],
		[".obsidian-plugins", false],
		["random", false],
	])("%s → %s (defaults)", (dir, expected) => {
		expect(descendAllowed(dir, cfg(), SELF)).toBe(expected);
	});

	it("plugins descends when either community switch is on, never into self", () => {
		const on = cfg({ communityPluginData: true });
		expect(descendAllowed("plugins", on, SELF)).toBe(true);
		expect(descendAllowed("plugins/x", on, SELF)).toBe(true);
		expect(descendAllowed("plugins/x/y", on, SELF)).toBe(false);
		expect(descendAllowed(`plugins/${SELF}`, on, SELF)).toBe(false);

		// communityPlugin alone must reach the plugin dirs too, or its
		// manifest/main.js/styles.css are never even looked at.
		const code = cfg({ communityPlugin: true });
		expect(descendAllowed("plugins", code, SELF)).toBe(true);
		expect(descendAllowed("plugins/x", code, SELF)).toBe(true);
		expect(descendAllowed(`plugins/${SELF}`, code, SELF)).toBe(false);

		const none = cfg({ communityPlugin: false, communityPluginData: false });
		expect(descendAllowed("plugins", none, SELF)).toBe(false);
	});
});
