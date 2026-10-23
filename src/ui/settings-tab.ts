import { Notice, PluginSettingTab, Setting } from "obsidian";
import { getStrings, setOverriddenLocale } from "../i18n";
import { testConnection } from "../connection";
import type { SelectiveConfigSettings } from "../config/filter";
import { normalizeExcludedFolders } from "../sync/scope";
import type { ScopeSettings } from "../sync/scope";
import {
	addMultiSelect,
	addNumberSlider,
	addSection,
	sliderReadout,
} from "./settings-sections";
import type NotionHubSyncPlugin from "../main";

/** The five file-kind switches in `ScopeSettings` (notes are always on). */
type ScopeKey = Exclude<keyof ScopeSettings, "excludedFolders">;

export class NotionHubSettingTab extends PluginSettingTab {
	constructor(private readonly plugin: NotionHubSyncPlugin) {
		super(plugin.app, plugin);
	}

	/** One slider row. The unit lives in the readout, not the name, so the
	 * name stays short and the range is visible without opening a tooltip. */
	private numberSlider(
		containerEl: HTMLElement,
		name: string,
		desc: string | null,
		opts: {
			min: number;
			max: number;
			step: number;
			value: number;
			unit: string;
			/** Text shown at 0 instead of "0 …" — several sliders use 0 as off. */
			offAtZero?: string;
		},
		write: (n: number) => void,
	): void {
		const s = new Setting(containerEl).setName(name);
		if (desc) s.setDesc(desc);
		addNumberSlider(s, {
			min: opts.min,
			max: opts.max,
			step: opts.step,
			value: opts.value,
			format: (n) => sliderReadout(n, opts.unit, opts.offAtZero),
			onInput: write,
			save: () => this.plugin.saveSettings(),
			ariaLabel: name,
		});
	}

	private toggle(
		containerEl: HTMLElement,
		name: string,
		desc: string | null,
		get: () => boolean,
		set: (v: boolean) => void,
	): Setting {
		const s = new Setting(containerEl).setName(name);
		if (desc) s.setDesc(desc);
		return s.addToggle((toggle) =>
			toggle.setValue(get()).onChange(async (value) => {
				set(value);
				await this.plugin.saveSettings();
			}),
		);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("nhs-settings");
		const strings = getStrings();
		const st = this.plugin.settings;

		// ── connection ───────────────────────────────────────
		addSection(containerEl, strings.sectionConnection);

		new Setting(containerEl)
			.setName(strings.settingsLanguage)
			.setDesc(strings.settingsLanguageDescription)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("auto", strings.languageAuto)
					.addOption("zh-CN", "简体中文")
					.addOption("en", "English")
					.setValue(st.language)
					.onChange(async (value) => {
						st.language = value;
						setOverriddenLocale(value);
						await this.plugin.saveSettings();
						// rebuild so every label picks up the new language
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName(strings.integrationToken)
			.setDesc(strings.integrationTokenDescription)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(st.token).onChange(async (value) => {
					st.token = value;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName(strings.rootPage)
			.setDesc(strings.rootPageDescription)
			.addText((text) => {
				text.setPlaceholder(strings.rootPagePlaceholder)
					.setValue(st.rootPage)
					.onChange(async (value) => {
						st.rootPage = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).addButton((button) =>
			button
				.setButtonText(strings.testConnection)
				.setCta()
				.onClick(async () => {
					button.setButtonText(strings.testingConnection);
					button.setDisabled(true);
					try {
						const result = await testConnection(st);
						if (result.ok) {
							new Notice(
								strings.connectionSuccess(
									result.botName,
									result.pageTitle,
								),
							);
						} else {
							new Notice(result.message);
						}
					} finally {
						button.setDisabled(false);
						button.setButtonText(strings.testConnection);
					}
				}),
		);

		// ── sync scope ───────────────────────────────────────
		addSection(containerEl, strings.settingsScope);

		// Five file-type switches on one chip row: notes always sync, so the
		// only decisions left are these, and they read as one question.
		new Setting(containerEl)
			.setName(strings.settingsScopeFileTypes)
			.setDesc(strings.settingsScopeDescription)
			.then((s) => {
				// Chip rows are wider than a toggle: put the controls on their
				// own line instead of squeezing the description into a column.
				s.settingEl.addClass("nhs-setting-stacked");
				addMultiSelect(
					s.controlEl,
					[
						{ key: "images", label: strings.settingsScopeImages },
						{ key: "audio", label: strings.settingsScopeAudio },
						{ key: "video", label: strings.settingsScopeVideo },
						{ key: "pdf", label: strings.settingsScopePdf },
						{
							key: "other",
							label: strings.settingsScopeOther,
							title: strings.settingsScopeOtherDescription,
						},
					],
					{
						isOn: (k) => st.scope[k as ScopeKey],
						set: (k, on) => {
							st.scope[k as ScopeKey] = on;
						},
						commit: () => this.plugin.saveSettings(),
					},
					{
						selectAll: strings.settingsSelectAll,
						selectNone: strings.settingsSelectNone,
					},
				);
			});

		new Setting(containerEl)
			.setName(strings.settingsExcludedFolders)
			.setDesc(strings.settingsExcludedFoldersDescription)
			.addTextArea((area) =>
				area
					.setPlaceholder(strings.settingsExcludedFoldersPlaceholder)
					.setValue(st.scope.excludedFolders.join("\n"))
					.onChange(async (value) => {
						st.scope.excludedFolders = normalizeExcludedFolders(
							value.split("\n"),
						);
						await this.plugin.saveSettings();
					}),
			);

		this.numberSlider(
			containerEl,
			strings.settingsMaxFileSize,
			strings.settingsMaxFileSizeDescription,
			{
				min: 1,
				max: 2000,
				step: 1,
				value: st.maxFileSizeMB,
				unit: strings.unitMB,
			},
			(n) => {
				st.maxFileSizeMB = n;
			},
		);

		// ── automatic sync ───────────────────────────────────
		addSection(containerEl, strings.sectionAutoSync);

		this.toggle(
			containerEl,
			strings.settingsAutoSyncToggle,
			strings.settingsAutoSyncDescription,
			() => st.autoSync,
			(v) => {
				st.autoSync = v;
			},
		);

		this.numberSlider(
			containerEl,
			strings.settingsAutoSyncDebounce,
			strings.settingsAutoSyncDebounceDescription,
			{
				min: 1,
				max: 300,
				step: 1,
				value: st.autoSyncDebounceSeconds,
				unit: strings.unitSeconds,
			},
			(n) => {
				st.autoSyncDebounceSeconds = n;
			},
		);

		this.numberSlider(
			containerEl,
			strings.settingsAutoSyncInterval,
			strings.settingsAutoSyncIntervalDescription,
			{
				min: 0,
				max: 1440,
				step: 1,
				value: st.autoSyncIntervalMinutes,
				unit: strings.unitMinutes,
				offAtZero: strings.valueOff,
			},
			(n) => {
				st.autoSyncIntervalMinutes = n;
			},
		);

		this.toggle(
			containerEl,
			strings.settingsSyncOnStartup,
			strings.settingsSyncOnStartupDescription,
			() => st.syncOnStartup,
			(v) => {
				st.syncOnStartup = v;
			},
		);

		this.toggle(
			containerEl,
			strings.settingsSyncOnForeground,
			strings.settingsSyncOnForegroundDescription,
			() => st.syncOnForeground,
			(v) => {
				st.syncOnForeground = v;
			},
		);

		// ── version history ──────────────────────────────────
		addSection(containerEl, strings.settingsHistory);

		this.toggle(
			containerEl,
			strings.settingsHistoryToggle,
			strings.settingsHistoryDescription,
			() => st.historyEnabled,
			(v) => {
				st.historyEnabled = v;
			},
		);

		this.numberSlider(
			containerEl,
			strings.settingsHistoryInterval,
			strings.settingsHistoryIntervalDescription,
			{
				min: 0,
				max: 1440,
				step: 1,
				value: st.historyIntervalMinutes,
				unit: strings.unitMinutes,
				offAtZero: strings.valueOff,
			},
			(n) => {
				st.historyIntervalMinutes = n;
			},
		);

		this.numberSlider(
			containerEl,
			strings.settingsHistoryMaxVersions,
			null,
			{
				min: 1,
				max: 1000,
				step: 1,
				value: st.historyMaxVersions,
				unit: strings.unitVersions,
			},
			(n) => {
				st.historyMaxVersions = n;
			},
		);

		this.numberSlider(
			containerEl,
			strings.settingsHistoryRetentionDays,
			null,
			{
				min: 1,
				max: 3650,
				step: 1,
				value: st.historyRetentionDays,
				unit: strings.unitDays,
			},
			(n) => {
				st.historyRetentionDays = n;
			},
		);

		this.numberSlider(
			containerEl,
			strings.settingsFullAuditHours,
			strings.settingsFullAuditHoursDescription,
			{
				min: 1,
				max: 168,
				step: 1,
				value: st.fullAuditHours,
				unit: strings.unitHours,
			},
			(n) => {
				st.fullAuditHours = n;
			},
		);

		// ── .obsidian config sync ────────────────────────────
		addSection(containerEl, strings.settingsConfigSync);

		this.toggle(
			containerEl,
			strings.settingsConfigSyncToggle,
			strings.settingsConfigSyncDescription,
			() => st.configSync.enabled,
			(v) => {
				st.configSync.enabled = v;
			},
		);

		// Eight categories on one chip row — same reason as the file types.
		// The community-data warning moves to the row description: a chip has
		// nowhere to put a paragraph, and it matters only while that chip is on.
		const cats: Array<[keyof SelectiveConfigSettings, string]> = [
			["app", strings.configCatApp],
			["appearance", strings.configCatAppearance],
			["appearanceData", strings.configCatAppearanceData],
			["hotkey", strings.configCatHotkey],
			["corePlugin", strings.configCatCorePlugin],
			["corePluginData", strings.configCatCorePluginData],
			["communityPlugin", strings.configCatCommunityPlugin],
			["communityPluginData", strings.configCatCommunityPluginData],
		];
		const catSetting = new Setting(containerEl)
			.setName(strings.settingsConfigSyncCategories)
			.then((s) => s.settingEl.addClass("nhs-setting-stacked"));
		// The warning is a sentence, not a chip: show it only while the chip it
		// is about is on, and collapse the empty desc row instead of leaving a
		// blank line in the settings list.
		const paintCatDesc = (): void => {
			const warn = st.configSync.communityPluginData;
			catSetting.setDesc(warn ? strings.configCommunityDataWarning : "");
			catSetting.descEl.toggleClass("nhs-desc-empty", !warn);
		};
		addMultiSelect(
			catSetting.controlEl,
			cats.map(([key, label]) => ({ key, label })),
			{
				isOn: (k) => st.configSync[k as keyof SelectiveConfigSettings],
				set: (k, on) => {
					st.configSync[k as keyof SelectiveConfigSettings] = on;
					paintCatDesc();
				},
				commit: () => this.plugin.saveSettings(),
			},
			{
				selectAll: strings.settingsSelectAll,
				selectNone: strings.settingsSelectNone,
			},
		);
		paintCatDesc();

		// ── advanced ─────────────────────────────────────────
		addSection(containerEl, strings.sectionAdvanced);

		this.numberSlider(
			containerEl,
			strings.settingsDeleteGuard,
			strings.settingsDeleteGuardDescription,
			{
				min: 0,
				max: 1000,
				step: 1,
				value: st.deleteGuardThreshold,
				unit: strings.unitFiles,
				offAtZero: strings.valueOff,
			},
			(n) => {
				st.deleteGuardThreshold = n;
			},
		);

		this.toggle(
			containerEl,
			strings.settingsDebugLog,
			strings.settingsDebugLogDescription,
			() => st.debugLog,
			(v) => {
				st.debugLog = v;
			},
		);
	}
}
