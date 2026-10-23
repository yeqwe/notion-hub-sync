import type { NotionClient } from "./client";

interface BotUserResponse {
	name?: string;
}

interface PageResponse {
	properties?: Record<
		string,
		{
			type?: string;
			title?: Array<{ plain_text?: string }>;
		}
	>;
}

export class NotionRepository {
	constructor(private readonly client: NotionClient) {}

	async getBotUser(): Promise<{ name: string }> {
		const res = await this.client.request<BotUserResponse>(
			"GET",
			"/users/me",
		);
		return { name: res.name ?? "" };
	}

	async getPageTitle(pageId: string): Promise<string> {
		const res = await this.client.request<PageResponse>(
			"GET",
			`/pages/${pageId}`,
		);
		const properties = res.properties ?? {};
		for (const property of Object.values(properties)) {
			if (property.type === "title") {
				return (property.title ?? [])
					.map((part) => part.plain_text ?? "")
					.join("");
			}
		}
		return "";
	}
}
