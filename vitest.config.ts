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
		include: ["src/**/*.test.ts"],
		exclude: [
			"**/*.live.test.ts",
			"学习项目/**",
			"node_modules/**",
		],
	},
});
