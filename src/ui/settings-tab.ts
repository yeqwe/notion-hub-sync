import { Notice, PluginSettingTab, Setting } from "obsidian";
import { getStrings, setOverriddenLocale } from "../i18n";
import { testConnection } from "../connection";
import type { SelectiveConfigSettings } from "../config/filter";
import { normalizeExcludedFolders } from "../sync/scope";
import type { ScopeSettings } from "../sync/scope";
import { addMultiSelect } from "./settings-sections";
import type NotionHubSyncPlugin from "../main";

/** The five file-kind switches in `ScopeSettings` (notes are always on). */
type ScopeKey = Exclude<keyof ScopeSettings, "excludedFolders">;

export class NotionHubSettingTab extends PluginSettingTab {
	constructor(private readonly plugin: NotionHubSyncPlugin) {
		super(plugin.app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const strings = getStrings();

		new Setting(containerEl)
			.setName(strings.settingsLanguage)
			.setDesc(strings.settingsLanguageDescription)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("auto", strings.languageAuto)
					.addOption("zh-CN", "简体中文")
					.addOption("en", "English")
					.setValue(this.plugin.settings.language)
					.onChange(async (value) => {
						this.plugin.settings.language = value;
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
				text.setValue(this.plugin.settings.token).onChange(
					async (value) => {
						this.plugin.settings.token = value;
						await this.plugin.saveSettings();
					},
				);
			});

		new Setting(containerEl)
			.setName(strings.rootPage)
			.setDesc(strings.rootPageDescription)
			.addText((text) => {
				text.setPlaceholder(strings.rootPagePlaceholder)
					.setValue(this.plugin.settings.rootPage)
					.onChange(async (value) => {
						this.plugin.settings.rootPage = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(strings.settingsHistory)
			.setDesc(strings.settingsHistoryDescription)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.historyEnabled)
					.onChange(async (value) => {
						this.plugin.settings.historyEnabled = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(strings.settingsHistoryInterval)
			.setDesc(strings.settingsHistoryIntervalDescription)
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.historyIntervalMinutes))
					.onChange(async (value) => {
						const n = Number(value);
						if (Number.isFinite(n) && n >= 0) {
							this.plugin.settings.historyIntervalMinutes = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName(strings.settingsHistoryMaxVersions)
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.historyMaxVersions))
					.onChange(async (value) => {
						const n = Number(value);
						if (Number.isInteger(n) && n > 0) {
							this.plugin.settings.historyMaxVersions = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName(strings.settingsHistoryRetentionDays)
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.historyRetentionDays))
					.onChange(async (value) => {
						const n = Number(value);
						if (Number.isInteger(n) && n > 0) {
							this.plugin.settings.historyRetentionDays = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName(strings.settingsFullAuditHours)
			.setDesc(strings.settingsFullAuditHoursDescription)
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.fullAuditHours))
					.onChange(async (value) => {
						const n = Number(value);
						if (Number.isFinite(n) && n > 0) {
							this.plugin.settings.fullAuditHours = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName(strings.settingsAutoSync)
			.setDesc(strings.settingsAutoSyncDescription)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoSync)
					.onChange(async (value) => {
						this.plugin.settings.autoSync = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(strings.settingsAutoSyncDebounce)
			.setDesc(strings.settingsAutoSyncDebounceDescription)
			.addText((text) =>
				text
					.setValue(
						String(this.plugin.settings.autoSyncDebounceSeconds),
					)
					.onChange(async (value) => {
						const n = Number(value);
						if (Number.isFinite(n) && n >= 1) {
							this.plugin.settings.autoSyncDebounceSeconds = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName(strings.settingsAutoSyncInterval)
			.setDesc(strings.settingsAutoSyncIntervalDescription)
			.addText((text) =>
				text
					.setValue(
						String(this.plugin.settings.autoSyncIntervalMinutes),
					)
					.onChange(async (value) => {
						const n = Number(value);
						if (Number.isFinite(n) && n >= 0) {
							this.plugin.settings.autoSyncIntervalMinutes = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName(strings.settingsSyncOnStartup)
			.setDesc(strings.settingsSyncOnStartupDescription)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(strings.settingsSyncOnForeground)
			.setDesc(strings.settingsSyncOnForegroundDescription)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnForeground)
					.onChange(async (value) => {
						this.plugin.settings.syncOnForeground = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(strings.settingsMaxFileSize)
			.setDesc(strings.settingsMaxFileSizeDescription)
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.maxFileSizeMB))
					.onChange(async (value) => {
						const n = Number(value);
						if (Number.isFinite(n) && n > 0) {
							this.plugin.settings.maxFileSizeMB = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		// ── sync scope ────────────────────────────────────────
		// Five file-type switches on one chip row: notes always sync, so the
		// only decisions left are these, and they read as one question.
		new Setting(containerEl)
			.setName(strings.settingsScope)
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
						isOn: (k) => this.plugin.settings.scope[k as ScopeKey],
						set: (k, on) => {
							this.plugin.settings.scope[k as ScopeKey] = on;
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
					.setValue(
						this.plugin.settings.scope.excludedFolders.join("\n"),
					)
					.onChange(async (value) => {
						this.plugin.settings.scope.excludedFolders =
							normalizeExcludedFolders(value.split("\n"));
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(strings.settingsDeleteGuard)
			.setDesc(strings.settingsDeleteGuardDescription)
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.deleteGuardThreshold))
					.onChange(async (value) => {
						const n = Number(value);
						if (Number.isInteger(n) && n >= 0) {
							this.plugin.settings.deleteGuardThreshold = n;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName(strings.settingsDebugLog)
			.setDesc(strings.settingsDebugLogDescription)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debugLog)
					.onChange(async (value) => {
						this.plugin.settings.debugLog = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(strings.settingsConfigSync)
			.setDesc(strings.settingsConfigSyncDescription)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.configSync.enabled)
					.onChange(async (value) => {
						this.plugin.settings.configSync.enabled = value;
						await this.plugin.saveSettings();
					}),
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
			const warn = this.plugin.settings.configSync.communityPluginData;
			catSetting.setDesc(warn ? strings.configCommunityDataWarning : "");
			catSetting.descEl.toggleClass("nhs-desc-empty", !warn);
		};
		addMultiSelect(
			catSetting.controlEl,
			cats.map(([key, label]) => ({ key, label })),
			{
				isOn: (k) =>
					this.plugin.settings.configSync[
						k as keyof SelectiveConfigSettings
					],
				set: (k, on) => {
					this.plugin.settings.configSync[
						k as keyof SelectiveConfigSettings
					] = on;
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

		new Setting(containerEl).addButton((button) =>
			button
				.setButtonText(strings.testConnection)
				.onClick(async () => {
					button.setButtonText(strings.testingConnection);
					button.setDisabled(true);
					try {
						const result = await testConnection(
							this.plugin.settings,
						);
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
	}
}
