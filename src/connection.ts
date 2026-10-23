import { NotionApiError, NotionClient } from "./notion/client";
import { parseNotionId } from "./notion/ids";
import { NotionRepository } from "./notion/repository";
import { getStrings } from "./i18n";
import type { NotionHubSettings } from "./settings";

export type ConnectionResult =
	| { ok: true; botName: string; pageTitle: string }
	| { ok: false; message: string };

export async function testConnection(
	settings: NotionHubSettings,
	client?: NotionClient,
): Promise<ConnectionResult> {
	const strings = getStrings();

	if (!settings.token.trim()) {
		return { ok: false, message: strings.missingToken };
	}
	if (!settings.rootPage.trim()) {
		return { ok: false, message: strings.missingRootPage };
	}
	const pageId = parseNotionId(settings.rootPage);
	if (!pageId) {
		return { ok: false, message: strings.invalidRootPage };
	}

	const notion =
		client ?? new NotionClient({ token: settings.token.trim() });
	const repository = new NotionRepository(notion);

	try {
		const bot = await repository.getBotUser();
		const pageTitle = await repository.getPageTitle(pageId);
		return { ok: true, botName: bot.name, pageTitle };
	} catch (err) {
		if (err instanceof NotionApiError) {
			if (err.status === 401) {
				return { ok: false, message: strings.invalidToken };
			}
			if (err.status === 404 || err.code === "object_not_found") {
				return { ok: false, message: strings.rootPageNotFound };
			}
			return {
				ok: false,
				message: strings.connectionFailed(err.message),
			};
		}
		return {
			ok: false,
			message: strings.connectionFailed(
				err instanceof Error ? err.message : String(err),
			),
		};
	}
}
