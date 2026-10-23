import { Notice, PluginSettingTab, Setting } from "obsidian";
import { getStrings, setOverriddenLocale } from "../i18n";
import { testConnection } from "../connection";
import type { SelectiveConfigSettings } from "../config/filter";
import type NotionHubSyncPlugin from "../main";

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
		for (const [key, label] of cats) {
			const s = new Setting(containerEl).setName(label).addToggle(
				(toggle) =>
					toggle
						.setValue(this.plugin.settings.configSync[key])
						.onChange(async (value) => {
							this.plugin.settings.configSync[key] = value;
							await this.plugin.saveSettings();
							if (key === "communityPluginData") {
								this.display();
							}
						}),
			);
			if (
				key === "communityPluginData" &&
				this.plugin.settings.configSync.communityPluginData
			) {
				s.setDesc(strings.configCommunityDataWarning);
			}
		}

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
