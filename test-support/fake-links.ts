import type { LinkResolver } from "../src/convert/links";

export const NOTE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const FOLDER_NOTE_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

export const fakeLinks: LinkResolver = {
	pageIdForTarget: (target) =>
		({ Note: NOTE_ID, "Folder/Note": FOLDER_NOTE_ID })[target] ?? null,
	pathForPageId: (id) => {
		const hex = id.replace(/-/g, "").toLowerCase();
		if (hex === NOTE_ID) return "Note.md";
		if (hex === FOLDER_NOTE_ID) return "Folder/Note.md";
		return null;
	},
};
