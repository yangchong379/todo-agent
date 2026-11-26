import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ChatMessage } from "../shared/chat.ts";
import { createReply } from "./agent.ts";
import { createApp } from "./app.ts";
import { createJsonTaskStore } from "./task-store.ts";

async function startTestApp(t: TestContext, options: { live?: boolean; filename?: string } = {}) {
  let filename = options.filename;
  if (!filename) {
    const directory = await mkdtemp(join(tmpdir(), "todo-agent-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    filename = join(directory, "tasks.json");
  }
  const tasks = createJsonTaskStore(filename);
  const conversations: ChatMessage[][] = [];
  async function stubReply(messages: ChatMessage[]) {
    conversations.push(messages);
    return "收到";
  }
  const app = createApp({ tasks, reply: options.live ? createReply(tasks) : stubReply });

  const server = app.listen(0, "127.0.0.1");
  t.after(() => server[Symbol.asyncDispose]());
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;

  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }

  async function chat(content: string, messages: ChatMessage[] = []): Promise<string> {
    const response = await request("POST", "/api/chat", {
      messages: [...messages, { role: "user", content }],
    });
    assert.equal(response.status, 200);
    return response.body.reply;
  }

  return { request, chat, conversations, filename };
}

test("任务 API 可以创建、列出、修改和删除任务", async (t) => {
  const { request } = await startTestApp(t);
  const collection = "/api/tasks";
  assert.deepEqual(await request("GET", collection), { status: 200, body: [] });

  const created = await request("POST", collection, { title: " 买牛奶 " });
  assert.equal(created.status, 201);
  const task = created.body;
  assert.equal(typeof task.id, "string");
  assert.deepEqual(task, { id: task.id, title: "买牛奶", done: false });

  const item = collection + "/" + task.id;
  const completed = await request("PATCH", item, { done: true });
  assert.deepEqual(completed, { status: 200, body: { ...task, done: true } });
  const renamed = await request("PATCH", item, { title: "买面包" });
  assert.deepEqual(renamed, { status: 200, body: { ...task, title: "买面包", done: true } });
  assert.deepEqual((await request("GET", collection)).body, [renamed.body]);

  assert.deepEqual(await request("DELETE", item), { status: 204, body: null });
  assert.deepEqual((await request("GET", collection)).body, []);
});

test("任务 API 拒绝无效输入并区分不存在的任务", async (t) => {
  const { request } = await startTestApp(t);
  assert.equal((await request("POST", "/api/tasks", { title: " " })).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", {})).status, 400);
  assert.equal((await request("PATCH", "/api/tasks/missing", { done: true })).status, 404);
  assert.equal((await request("DELETE", "/api/tasks/missing")).status, 404);
});

test("更新已有 JSON 清单时保留其他任务和扩展字段", async (t) => {
  const { request, filename } = await startTestApp(t);
  const first = { id: "a", title: "买牛奶", done: false, priority: 1 };
  const second = { id: "b", title: "取快递", done: false };
  await writeFile(filename, JSON.stringify([first, second]));

  assert.equal((await request("PATCH", "/api/tasks/a", { done: true })).status, 200);
  assert.deepEqual(createJsonTaskStore(filename).list(), [{ ...first, done: true }, second]);
});

test("聊天 API 只将有效的完整对话传给智能体，并返回其回复", async (t) => {
  const { request, conversations } = await startTestApp(t);
  const messages = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好！" },
    { role: "user", content: "今天有哪些待办？" },
  ];
  const valid = await request("POST", "/api/chat", { messages });
  assert.deepEqual(valid, { status: 200, body: { reply: "收到" } });

  const invalid = await request("POST", "/api/chat", { messages: messages.slice(0, 2) });
  assert.equal(invalid.status, 400);
  assert.deepEqual(conversations, [messages]);
});

test("中文验收对话通过聊天和任务接口更新同一份清单，并可在重启后查询", async (t) => {
  const { request, chat, filename } = await startTestApp(t, { live: true });
  const messages: ChatMessage[] = [];
  async function say(content: string) {
    const reply = await chat(content, messages);
    messages.push({ role: "user", content }, { role: "assistant", content: reply });
    return reply;
  }

  assert.equal(await say("帮我记一下买牛奶"), "已添加待办「买牛奶」。");
  assert.equal(await say("再记一条取快递"), "已添加待办「取快递」。");
  assert.match(await say("我有哪些任务？"), /待办（2）\n• 买牛奶\n• 取快递/u);
  assert.equal(await say("牛奶买好了"), "已完成「买牛奶」。");
  assert.deepEqual(
    (await request("GET", "/api/tasks")).body.map(
      ({ title, done }: { title: string; done: boolean }) => [title, done],
    ),
    [
      ["买牛奶", true],
      ["取快递", false],
    ],
  );
  assert.equal(await say("取快递这条删掉吧"), "已删除「取快递」。");
  assert.match(await say("再给我看看清单"), /待办任务。\n\n已完成（1）\n• 买牛奶$/u);

  const fresh = await startTestApp(t, { live: true, filename });
  assert.match(await fresh.chat("看看我的待办"), /已完成（1）\n• 买牛奶$/u);
});

test("完成时匹配自然语序，重复请求不改变既有完成状态", async (t) => {
  const { chat, request } = await startTestApp(t, { live: true });

  assert.match(await chat("我有哪些任务？"), /清单还是空的/u);
  assert.equal(await chat("小明，请帮我记一下「洗衣服」！"), "已添加待办「洗衣服」。");
  assert.match(await chat("帮我记一下洗衣服"), /已经在待办清单/u);
  assert.equal(await chat("衣服已经洗好了"), "已完成「洗衣服」。");
  assert.match(await chat("衣服洗好了"), /已经是已完成/u);

  await request("POST", "/api/tasks", { title: "晒衣服" });
  assert.equal(await chat("看看还没完成的任务"), "待办（1）\n• 晒衣服");
  assert.equal(await chat("我有哪些任务已完成？"), "已完成（1）\n• 洗衣服");
  assert.equal(await chat("再记一条洗衣服"), "已添加待办「洗衣服」。");
  assert.equal(await chat("衣服洗好了"), "已完成「洗衣服」。");
  assert.equal(await chat("我有哪些任务已完成？"), "已完成（2）\n• 洗衣服\n• 洗衣服");
});

test("有多个匹配、缺少目标、询问或否定时不会修改任务", async (t) => {
  const { chat, request } = await startTestApp(t, { live: true });
  await chat("添加 买牛奶");
  await chat("添加 喝牛奶");
  const before = (await request("GET", "/api/tasks")).body;

  assert.match(await chat("删掉牛奶"), /有 2 条匹配/u);
  assert.match(await chat("删掉这条"), /请带上任务名称/u);
  assert.match(await chat("删掉取快递"), /没找到/u);
  await chat("不要删掉买牛奶");
  await chat("买牛奶完成了？");
  await chat("买牛奶还没有完成");
  await chat("再记一条取快递，然后删掉买牛奶");
  assert.match(await chat("帮我记一下"), /1 至 200/u);
  assert.match(await chat("帮我记一下" + "字".repeat(201)), /1 至 200/u);
  assert.deepEqual((await request("GET", "/api/tasks")).body, before);
  assert.equal(await chat("删掉买牛奶"), "已删除「买牛奶」。");
});

test("日程、义务和换一种说法的请求都能写入同一份清单", async (t) => {
  const { chat, request } = await startTestApp(t, { live: true });
  const plans = [
    ["我晚上有个会议", "晚上有个会议"],
    ["明天得去取快递", "明天去取快递"],
    ["周末下午三点看牙", "周末下午三点看牙"],
    ["我打算给妈妈打电话", "给妈妈打电话"],
    ["能帮我把周五交报告放进我的待办吗？", "周五交报告"],
  ] as const;
  for (const [message, title] of plans) {
    assert.equal(await chat(message), "已添加待办「" + title + "」。");
  }
  assert.match(await chat("还有哪些事没做？"), /待办（5）/u);
  assert.match(await chat("帮我记一下晚上有个会议"), /已经在待办/u);
  assert.equal(await chat("我开完会了"), "已完成「晚上有个会议」。");
  assert.equal(await chat("我取完快递了"), "已完成「明天去取快递」。");
  const { body } = await request("GET", "/api/tasks");
  assert.deepEqual(
    body.map(({ title }: { title: string }) => title),
    plans.map(([, title]) => title),
  );
  assert.deepEqual(
    body.map(({ done }: { done: boolean }) => done),
    [true, true, false, false, false],
  );
});

test("问题、否定、假设、闲聊和已经过去的日程不会新增任务", async (t) => {
  const { chat, request } = await startTestApp(t, { live: true });
  for (const message of [
    "我晚上有个会议吗？",
    "明天要不要去取快递",
    "我晚上不用开会",
    "晚上去不了医院",
    "我晚上有个会议但取消了",
    "如果我晚上有个会议，就改天再聊",
    "可能今晚有会",
    "我晚上有机会",
    "今天真冷",
    "昨天晚上有个会议",
  ]) {
    assert.doesNotMatch(await chat(message), /已添加待办/u, message);
  }
  assert.deepEqual((await request("GET", "/api/tasks")).body, []);
});

test("多场会议未指明目标时不替用户选择，准备会议的任务不算作会议", async (t) => {
  const { chat, request } = await startTestApp(t, { live: true });
  await chat("今晚有个会议");
  await chat("明晚开会");
  await chat("帮我记一下准备会议资料");

  assert.match(await chat("会议结束了"), /有 2 条匹配/u);
  assert.match(await chat("还有哪些事没做？"), /待办（3）/u);
  assert.equal(await chat("今晚有个会议结束了"), "已完成「今晚有个会议」。");
  assert.deepEqual(
    (await request("GET", "/api/tasks")).body.map(({ done }: { done: boolean }) => done),
    [true, false, false],
  );
});

test("用口语从待办里拿掉任务时，删除目标并保留其他任务", async (t) => {
  const { chat, request } = await startTestApp(t, { live: true });
  await chat("帮我记一下报名讲座");
  await chat("提醒我买牛奶");
  assert.equal(await chat("报名讲座完成了"), "已完成「报名讲座」。");

  assert.equal(await chat("能不能别把报名讲座从待办里拿掉？"), "好的，保留「报名讲座」。");
  assert.equal(await chat("能不能把报名讲座从待办里拿掉？"), "已删除「报名讲座」。");
  assert.match(await chat("我有哪些任务？"), /待办（1）\n• 买牛奶/u);
  assert.equal(await chat("「帮我把买牛奶这条从我的清单里移除。」"), "已删除「买牛奶」。");
  assert.deepEqual((await request("GET", "/api/tasks")).body, []);
});

test("同名任务可按完成状态删除，也可按上一轮候选的序号选择", async (t) => {
  const { chat, request } = await startTestApp(t, { live: true });
  await chat("帮我记一下报名讲座");
  await chat("报名讲座完成了");
  await chat("帮我记一下报名讲座");

  const command = "把报名讲座拿掉";
  const options = await chat(command);
  assert.match(options, /1\. 待办 · 「报名讲座」\n2\. 已完成 · 「报名讲座」/u);
  const history: ChatMessage[] = [
    { role: "user", content: command },
    { role: "assistant", content: options },
  ];
  const retry = await chat("第三条", history);
  assert.match(retry, /请回复序号/u);
  assert.equal(
    await chat("第一条", [
      ...history,
      { role: "user", content: "第三条" },
      { role: "assistant", content: retry },
    ]),
    "已删除「报名讲座」。",
  );
  assert.equal((await request("GET", "/api/tasks")).body.length, 1);
  assert.equal((await request("GET", "/api/tasks")).body[0].done, true);

  await chat("帮我记一下报名讲座");
  assert.equal(await chat("把待办的报名讲座拿掉"), "已删除「报名讲座」。");
  await chat("帮我记一下报名讲座");
  assert.equal(await chat("把已完成的报名讲座拿掉"), "已删除「报名讲座」。");
  assert.deepEqual(
    (await request("GET", "/api/tasks")).body.map(({ done }: { done: boolean }) => done),
    [false],
  );
});

test("发生清单变动后，序号仍对应原来的任务 ID", async (t) => {
  const { chat, request } = await startTestApp(t, { live: true });
  await chat("帮我记一下买牛奶");
  await chat("帮我记一下喝牛奶");
  const before = (await request("GET", "/api/tasks")).body;

  const command = "删掉牛奶";
  const options = await chat(command);
  await request("DELETE", "/api/tasks/" + before[0].id);
  await chat("帮我记一下买牛奶");
  assert.match(
    await chat("第一条", [
      { role: "user", content: command },
      { role: "assistant", content: options },
    ]),
    /已经变化/u,
  );
  assert.deepEqual(
    (await request("GET", "/api/tasks")).body.map(({ title }: { title: string }) => title),
    ["喝牛奶", "买牛奶"],
  );
});
