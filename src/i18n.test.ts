import { describe, expect, it, afterEach } from "vitest";
// Direct path (not "obsidian"): tsc type-checks against the real API
// surface, which has no test hooks. The vitest alias resolves "obsidian"
// to this same file, so both share one module instance.
import { setStubLanguage } from "../test-support/obsidian-runtime-stub";
import {
	getStrings,
	resolveLocale,
	setOverriddenLocale,
} from "./i18n";

afterEach(() => {
	setOverriddenLocale("auto");
	setStubLanguage("en");
});

describe("resolveLocale", () => {
	it("maps zh* to zh-CN and everything else to en", () => {
		expect(resolveLocale("zh")).toBe("zh-CN");
		expect(resolveLocale("zh-CN")).toBe("zh-CN");
		expect(resolveLocale("zh-TW")).toBe("zh-CN");
		expect(resolveLocale("en")).toBe("en");
		expect(resolveLocale("de")).toBe("en");
		expect(resolveLocale("")).toBe("en");
		expect(resolveLocale(undefined)).toBe("en");
	});
});

describe("getStrings language detection", () => {
	it("follows the app language from getLanguage()", () => {
		setStubLanguage("zh-CN");
		expect(getStrings().integrationToken).toBe("集成令牌");
		expect(getStrings().settingsLanguage).toBe("界面语言");
	});

	it("falls back to English for a non-Chinese app language", () => {
		setStubLanguage("ja");
		expect(getStrings().integrationToken).toBe("Integration token");
	});

	it("an explicit override wins over app detection", () => {
		setStubLanguage("zh-CN");
		setOverriddenLocale("en");
		expect(getStrings().integrationToken).toBe("Integration token");
		setOverriddenLocale("zh-CN");
		expect(getStrings().integrationToken).toBe("集成令牌");
	});

	it("\"auto\" resumes detection", () => {
		setStubLanguage("zh-CN");
		setOverriddenLocale("en");
		setOverriddenLocale("auto");
		expect(getStrings().integrationToken).toBe("集成令牌");
	});

	it("exposes the language picker labels in both locales", () => {
		setStubLanguage("en");
		expect(getStrings().languageAuto).toBe("Auto (follow Obsidian)");
		setStubLanguage("zh-CN");
		expect(getStrings().languageAuto).toBe("自动（跟随 Obsidian）");
	});

	it("an explicit language argument still wins over everything", () => {
		setStubLanguage("en");
		setOverriddenLocale("en");
		expect(getStrings("zh-CN").integrationToken).toBe("集成令牌");
	});
});
