// 复现：没人删除，笔记却被删掉。
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice, fileExists, type Device } from "../../test-support/device";
import { NodeVaultIO } from "../../test-support/node-vault-io";

function onlyId(d: Device): string {
	return Object.keys(d.state.entries)[0]!;
}

describe("accidental deletion", () => {
	it("A. 远端 GET /pages 失败一次 → 本地文件被 trash？", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { roundRobinPerRound: 10 });
		a.write("n.md", "重要内容\n");
		await a.sync();
		const id = onlyId(a);
		expect(fileExists(a, "n.md")).toBe(true);

		// 网络抖动一次：GET /pages/{id} 失败
		fake.failOnce(/^\/pages\/[0-9a-f]{32}$/, "GET");
		const r = await a.sync();
		console.log("A. report:", JSON.stringify(r));
		console.log("A. 本地文件还在?", fileExists(a, "n.md"));
		console.log("A. 远端页面 in_trash?", fake.pages.get(id)?.inTrash);
		expect(fileExists(a, "n.md")).toBe(true);
	});

	it("B. 本地 list 漏扫一个文件 → 远端页面被 trash？", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { roundRobinPerRound: 0 });
		a.write("n.md", "重要内容\n");
		await a.sync();
		const id = onlyId(a);

		// 模拟移动端 vault 索引还没列全：list() 少返回一个文件
		const inner = new NodeVaultIO(a.dir);
		const originalList = inner.list.bind(inner);
		inner.list = async () => {
			const r = await originalList();
			return {
				...r,
				files: r.files.filter((f) => f.path !== "n.md"),
			};
		};
		a.deps.vault = inner;

		const r = await a.sync();
		console.log("B. report:", JSON.stringify(r));
		console.log("B. 远端页面 in_trash?", fake.pages.get(id)?.inTrash);
		console.log("B. 本地文件还在?", fileExists(a, "n.md"));
		expect(fake.pages.get(id)?.inTrash).toBe(false);
	});

	it("C. 本地确实删了 → 远端该删（确认修复不阻碍正常删除）", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a", { roundRobinPerRound: 10 });
		a.write("n.md", "重要内容\n");
		await a.sync();
		const id = onlyId(a);

		await a.deps.vault.trash("n.md");
		const r = await a.sync();
		console.log("C. report:", JSON.stringify(r));
		expect(fake.pages.get(id)?.inTrash).toBe(true);
	});
});
