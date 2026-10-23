import { describe, expect, it } from "vitest";
import { diffTexts } from "./history-diff";

describe("diffTexts", () => {
	it("identical texts → all same", () => {
		const lines = diffTexts("a\nb\nc", "a\nb\nc");
		expect(lines).toEqual([
			{ type: "same", text: "a" },
			{ type: "same", text: "b" },
			{ type: "same", text: "c" },
		]);
	});

	it("CRLF endings are normalized", () => {
		const lines = diffTexts("a\r\nb\r\n", "a\nb");
		expect(lines).toEqual([
			{ type: "same", text: "a" },
			{ type: "same", text: "b" },
		]);
	});

	it("trailing newline does not produce a phantom empty line", () => {
		const lines = diffTexts("a\nb\n", "a\nb\n");
		expect(lines).toHaveLength(2);
	});

	it("paired del/add lines carry inline word changes", () => {
		const lines = diffTexts("the cat sat", "the dog sat");
		expect(lines).toHaveLength(2);
		expect(lines[0]!.type).toBe("del");
		expect(lines[1]!.type).toBe("add");
		const delRemoved = lines[0]!.changes!.filter((c) => c.removed);
		const addAdded = lines[1]!.changes!.filter((c) => c.added);
		expect(delRemoved.map((c) => c.value).join("")).toBe("cat");
		expect(addAdded.map((c) => c.value).join("")).toBe("dog");
	});

	it("unequal del/add blocks pair only up to the shorter side", () => {
		const lines = diffTexts("a\nx\ny\nb", "a\nz\nb");
		const del = lines.filter((l) => l.type === "del");
		const add = lines.filter((l) => l.type === "add");
		expect(del.map((l) => l.text)).toEqual(["x", "y"]);
		expect(add.map((l) => l.text)).toEqual(["z"]);
		// first removed line pairs with the added line → inline changes;
		// the leftover removed line has none
		expect(del[0]!.changes).toBeDefined();
		expect(del[1]!.changes).toBeUndefined();
		expect(add[0]!.changes).toBeDefined();
	});

	it("pure insertion / deletion", () => {
		expect(diffTexts("a", "a\nnew").map((l) => l.type)).toEqual([
			"same",
			"add",
		]);
		expect(diffTexts("a\nold", "a").map((l) => l.type)).toEqual([
			"same",
			"del",
		]);
	});
});
