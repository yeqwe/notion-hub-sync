import { describe, expect, it } from "vitest";
import { parseNotionId } from "./ids";

const UUID = "339ee678-f579-814a-a880-dad31be33d8e";
const HEX = "339ee678f579814aa880dad31be33d8e";

describe("parseNotionId", () => {
	it("accepts a 32-hex id", () => {
		expect(parseNotionId(HEX)).toBe(UUID);
	});

	it("accepts a dashed UUID", () => {
		expect(parseNotionId(UUID)).toBe(UUID);
	});

	it("normalizes uppercase", () => {
		expect(parseNotionId(HEX.toUpperCase())).toBe(UUID);
		expect(parseNotionId(UUID.toUpperCase())).toBe(UUID);
	});

	it("extracts the id from a Notion URL with slug and query", () => {
		expect(
			parseNotionId(
				`https://www.notion.so/ws/My-Page-${HEX}?pvs=4#fragment`,
			),
		).toBe(UUID);
	});

	it("returns null for garbage", () => {
		expect(parseNotionId("not a notion id")).toBeNull();
		expect(parseNotionId("")).toBeNull();
		expect(parseNotionId("https://www.notion.so/")).toBeNull();
	});
});
