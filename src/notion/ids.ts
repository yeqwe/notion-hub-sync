const HEX_32 = /[0-9a-fA-F]{32}/;
const DASHED_UUID =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function toDashedUuid(hex: string): string {
	const h = hex.toLowerCase();
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(
		16,
		20,
	)}-${h.slice(20)}`;
}

export function parseNotionId(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) {
		return null;
	}

	if (DASHED_UUID.test(trimmed)) {
		return trimmed.toLowerCase();
	}

	if (HEX_32.test(trimmed) && trimmed.length === 32) {
		return toDashedUuid(trimmed);
	}

	let path = trimmed;
	try {
		path = new URL(trimmed).pathname;
	} catch {
		// Not a URL: fall back to scanning the raw string.
	}

	const matches = path.match(/[0-9a-fA-F]{32}/g);
	if (!matches || matches.length === 0) {
		return null;
	}
	return toDashedUuid(matches[matches.length - 1] as string);
}
