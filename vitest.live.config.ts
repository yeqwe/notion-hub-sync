import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			obsidian: fileURLToPath(
				new URL("./test-support/obsidian-runtime-stub.ts", import.meta.url),
			),
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.live.test.ts"],
		exclude: ["学习项目/**", "node_modules/**"],
		testTimeout: 300_000,
		hookTimeout: 60_000,
	},
});
