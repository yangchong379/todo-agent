import assert from "node:assert/strict";
import { test } from "node:test";
import { interpret } from "./intent.ts";

test("DeepSeek 只解释本轮消息，拒绝无效参数或用户未提到的任务", async (t) => {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  });

  const message = "能把报名讲座放进我之后要处理的事项里面吗";
  let modelContent = '{"action":"create","title":"报名讲座"}';
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (url: Parameters<typeof globalThis.fetch>[0], options: RequestInit) => {
      assert.equal(String(url), "https://api.deepseek.com/chat/completions");
      assert.equal(typeof options.body, "string");
      const payload = JSON.parse(options.body as string);
      assert.deepEqual(payload.messages.slice(1), [{ role: "user", content: message }]);
      assert.deepEqual(payload.response_format, { type: "json_object" });
      return Response.json({ choices: [{ message: { content: modelContent } }] });
    },
  );

  assert.deepEqual(await interpret("帮我记一下洗衣服"), { action: "create", title: "洗衣服" });
  assert.equal(fetch.mock.callCount(), 0);

  assert.deepEqual(await interpret(message), { action: "create", title: "报名讲座" });
  modelContent = '{"action":"delete","target":"买牛奶"}';
  assert.deepEqual(await interpret(message), { action: "unknown" });
  modelContent = '{"action":"delete","target":"报名讲座","id":"made-up-id"}';
  assert.deepEqual(await interpret(message), { action: "unknown" });
  modelContent = " ";
  assert.deepEqual(await interpret(message), { action: "unknown" });
});
