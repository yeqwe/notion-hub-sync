// 令牌被撤销时，一轮同步必须：标记 authFailed、不改动 base、给出可读的警告。
// 这条路径以前只会往 failures 里堆 N 条 "unauthorized"，用户从计数里看不出
// 是令牌失效还是某个文件坏了。
import { describe, expect, it } from "vitest";
import { FakeNotion } from "../../test-support/fake-notion";
import { makeDevice } from "../../test-support/device";
import type { HttpResponse } from "../notion/client";

/** 让所有请求都返回 401，模拟 integration 被删掉。 */
const unauthorized = async (): Promise<HttpResponse> => ({
	status: 401,
	json: { code: "unauthorized", message: "API token is invalid." },
	headers: {},
});

describe("auth failure", () => {
	it("flags the round and leaves the base untouched", async () => {
		const fake = new FakeNotion();
		const rootId = fake.humanCreatePage("", "root");
		const a = makeDevice(fake, rootId, "a");
		a.write("a.md", "a\n");

		// first round succeeds normally, so there is a base to protect
		const ok = await a.sync();
		expect(ok.failed).toBe(0);
		const baseBefore = JSON.stringify(a.deps.state.entries);
		expect(Object.keys(a.deps.state.entries).length).toBeGreaterThan(0);

		// now the token is dead
		const dead = makeDevice(fake, rootId, "a", { request: unauthorized });
		dead.deps.state = a.deps.state; // same base
		a.write("b.md", "b\n"); // something pending, so a round has work to do
		const r = await dead.sync();

		expect(r.authFailed).toBe(true);
		expect(r.warnings.join(" ")).toMatch(/token/i);
		// base restored: a dead token must not be recorded as "these paths
		// were deleted", which would trash them once the token comes back
		expect(JSON.stringify(dead.deps.state.entries)).toBe(baseBefore);
	});
});
