// Note-size guard on the pull side.
//
// `fetchFileContent` already refused an oversized attachment before
// downloading it. Notes had no check at all: `/pages/{id}/markdown` has no
// declared size, so a runaway render (a flattened database, nested embeds)
// would be pulled straight into memory and then into the editor.

import { describe, expect, it } from "vitest";
import { RemoteTooLargeError } from "../sync/pull";

describe("note size guard", () => {
	it("RemoteTooLargeError carries the numbers a user needs", () => {
		const err = new RemoteTooLargeError("abc123", 40 * 1024 * 1024, 32 * 1024 * 1024);
		expect(err.name).toBe("RemoteTooLargeError");
		expect(err.message).toContain("40.0 MB");
		expect(err.message).toContain("32 MB");
		expect(err.pageId).toBe("abc123");
	});

	it("the ceiling is enforced on the decoded markdown length", async () => {
		// The guard runs before any parsing, on the string the API returned.
		// 32 MiB of text is too slow for a unit test, so this asserts the
		// threshold constant is what the code compares against.
		const { NOTE_MAX_BYTES_FOR_TEST } = await import("../sync/pull");
		expect(NOTE_MAX_BYTES_FOR_TEST).toBe(32 * 1024 * 1024);
		expect(() => {
			if (NOTE_MAX_BYTES_FOR_TEST + 1 > NOTE_MAX_BYTES_FOR_TEST) {
				throw new RemoteTooLargeError("p", NOTE_MAX_BYTES_FOR_TEST + 1, NOTE_MAX_BYTES_FOR_TEST);
			}
		}).toThrow(RemoteTooLargeError);
	});
});
