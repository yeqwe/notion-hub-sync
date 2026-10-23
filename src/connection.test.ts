import { describe, expect, it } from "vitest";
import { testConnection } from "./connection";
import { NotionClient, type HttpResponse } from "./notion/client";
import { DEFAULT_SETTINGS, type NotionHubSettings } from "./settings";

const PAGE_ID = "339ee678-f579-814a-a880-dad31be33d8e";

function settingsOf(partial: Partial<NotionHubSettings>): NotionHubSettings {
	return { ...DEFAULT_SETTINGS, token: "token", rootPage: PAGE_ID, deviceId: "d", ...partial };
}

function clientWith(
	respond: (path: string) => HttpResponse,
): { client: NotionClient; paths: string[] } {
	const paths: string[] = [];
	const client = new NotionClient({
		token: "token",
		minIntervalMs: 0,
		maxRetries: 0,
		request: async (req) => {
			paths.push(req.url.replace("https://api.notion.com/v1", ""));
			return respond(req.url);
		},
	});
	return { client, paths };
}

const successResponder = (path: string): HttpResponse => {
	if (path.endsWith("/users/me")) {
		return { status: 200, json: { name: "Sync Bot" }, headers: {} };
	}
	return {
		status: 200,
		json: {
			properties: {
				Name: {
					type: "title",
					title: [{ plain_text: "Vault Root" }],
				},
			},
		},
		headers: {},
	};
};

describe("testConnection", () => {
	it("succeeds with bot name and page title", async () => {
		const { client, paths } = clientWith(successResponder);
		const result = await testConnection(settingsOf({}), client);
		expect(result).toEqual({
			ok: true,
			botName: "Sync Bot",
			pageTitle: "Vault Root",
		});
		expect(paths).toEqual(["/users/me", `/pages/${PAGE_ID}`]);
	});

	it("fails without a token", async () => {
		const result = await testConnection(
			settingsOf({ token: "  " }),
			clientWith(successResponder).client,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toMatch(/token/i);
		}
	});

	it("reports invalid token on 401", async () => {
		const { client } = clientWith(() => ({
			status: 401,
			json: { code: "unauthorized", message: "API token is invalid." },
			headers: {},
		}));
		const result = await testConnection(settingsOf({}), client);
		expect(result).toEqual({
			ok: false,
			message: "Integration token is invalid.",
		});
	});

	it("reports missing/unshared root page on 404", async () => {
		const { client } = clientWith((path) => {
			if (path.endsWith("/users/me")) {
				return {
					status: 200,
					json: { name: "Sync Bot" },
					headers: {},
				};
			}
			return {
				status: 404,
				json: {
					code: "object_not_found",
					message: "Could not find page",
				},
				headers: {},
			};
		});
		const result = await testConnection(settingsOf({}), client);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.message).toContain("Connections");
		}
	});
});
