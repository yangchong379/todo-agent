import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReply } from "./agent.ts";
import { resolveDate, today } from "./task-dates.ts";
import { createJsonTaskStore } from "./task-store.ts";
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
  assert.deepEqual(await interpret("我晚上有个会议"), { action: "create", title: "晚上有个会议" });
  assert.deepEqual(await interpret("我晚上有个会议吗？"), { action: "unknown" });
  assert.equal(fetch.mock.callCount(), 0);

  assert.deepEqual(await interpret(message), { action: "create", title: "报名讲座" });
  modelContent = '{"action":"delete","target":"买牛奶"}';
  assert.deepEqual(await interpret(message), { action: "unknown" });
  modelContent = '{"action":"delete","target":"报名讲座","id":"made-up-id"}';
  assert.deepEqual(await interpret(message), { action: "unknown" });
  modelContent = " ";
  assert.deepEqual(await interpret(message), { action: "unknown" });
});

test("复杂的口语可以让模型拆出多个待办，逐项检查标题和时间是否来自原消息", async (t) => {
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  });

  const message = "周五的安排之一是报名讲座，另一个是替小杨校对展位图";
  let result = {
    action: "createMany",
    items: [
      { title: "报名讲座", when: "周五" },
      { title: "替小杨校对展位图", when: "周五" },
    ],
  };
  const mock = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] }),
  );

  assert.deepEqual(await interpret(message), result);
  result = { ...result, items: [result.items[0], { title: "缴纳停车费", when: "周五" }] };
  assert.deepEqual(await interpret(message), { action: "unknown" });
  result = { ...result, items: [{ title: "报名讲座", when: "明天" }] };
  assert.deepEqual(await interpret(message), { action: "unknown" });
  assert.equal(mock.mock.callCount(), 3);
});

test("模型给出不能换算的时间时仍保存待办，可在下一轮只说时段来补上", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "todo-schedules-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createJsonTaskStore(join(directory, "tasks.json"));
  const reply = createReply(store);
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  });
  const original = "复诊定在明早八点，邻居说把门口纸箱挪一下等雨停后再弄";
  const modelAnswer = {
    action: "createMany",
    items: [
      { title: "复诊", when: "明早八点" },
      { title: "把门口纸箱挪一下", when: "雨停后" },
    ],
  };
  const model = t.mock.method(globalThis, "fetch", async () =>
    Response.json({ choices: [{ message: { content: JSON.stringify(modelAnswer) } }] }),
  );
  const question = await reply([{ role: "user", content: original }]);
  assert.match(question, /已添加 2 条待办/u);
  assert.match(question, /「把门口纸箱挪一下」已记下，时间待确认/u);
  const [appointment, box] = store.list();
  assert.equal(appointment.dueTime, "08:00");
  assert.equal(box.dueDate, undefined);
  const answer = await reply([
    { role: "user", content: original },
    { role: "assistant", content: question },
    { role: "user", content: "晚上" },
  ]);
  assert.match(answer, /把门口纸箱挪一下」的时间补为.*晚上/u);
  assert.deepEqual(store.list()[0], appointment);
  assert.deepEqual(store.list()[1], {
    ...box,
    dueDate: resolveDate("明天", today()),
    duePeriod: "晚上",
  });
  assert.equal(model.mock.callCount(), 1);
});
