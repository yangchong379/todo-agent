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
import { resolveDate, resolveSchedule, today } from "./task-dates.ts";
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

test("按日期查询今天到期和逾期，任务日期及标签在重启后保留", async (t) => {
  const { chat, request, filename } = await startTestApp(t, { live: true });
  assert.equal(await chat("今天有哪些任务到期？"), "今天没有到期的任务。");
  await chat("帮我记一下今天交报告");
  await chat("明天得去取快递");
  await chat("帮我记一下准备汇报");
  assert.match(await chat("把准备汇报的截止日期设为2020-01-01"), /2020-01-01/u);
  assert.match(await chat("把交报告的优先级设为高"), /优先级设为高/u);
  assert.match(await chat("把交报告的工作量设为中"), /工作量设为中/u);
  assert.match(await chat("把交报告的截止日期设为2026-02-30"), /YYYY-MM-DD/u);
  const fresh = await startTestApp(t, { live: true, filename });
  const due = await fresh.chat("今天有哪些任务到期？");
  assert.match(due, /今天交报告（截止 \d{4}-\d{2}-\d{2} · 优先级高 · 工作量中）/u);
  assert.doesNotMatch(due, /取快递|准备汇报/u);
  assert.match(await fresh.chat("有哪些逾期任务？"), /准备汇报/u);
  const items = (await request("GET", "/api/tasks")).body;
  assert.equal(items[0].dueDate, today());
  assert.equal(items[0].priority, "high");
  assert.equal(items[0].effort, "medium");
  assert.equal(items[1].dueDate, resolveDate("明天", today()));
  await fresh.chat("把交报告的优先级设为无");
  assert.equal((await request("GET", "/api/tasks")).body[0].priority, null);
});

test("子任务可分组查看、改名、完成、恢复和删除", async (t) => {
  const { chat, request } = await startTestApp(t, { live: true });
  await chat("帮我记一下准备汇报");
  await chat("帮我记一下准备面试");
  assert.match(await chat("给准备汇报加个子任务：整理数据"), /添加子任务/u);
  assert.match(await chat("为准备面试添加子任务：整理数据"), /添加子任务/u);
  assert.match(await chat("看看准备汇报的子任务"), /准备汇报」的子任务\n待办（1）\n• 整理数据/u);
  assert.match(await chat("我的待办"), /• 准备汇报\n  ↳ 整理数据/u);
  assert.equal(await chat("完成准备汇报的子任务整理数据"), "已完成「整理数据」。");
  assert.match(await chat("把准备汇报的子任务整理数据标为未完成"), /恢复为待办/u);
  assert.match(await chat("把准备汇报的子任务整理数据改名为整理成本"), /改名为「整理成本」/u);
  assert.equal(await chat("把准备汇报的子任务整理成本删掉"), "已删除「整理成本」。");
  assert.match(await chat("看看准备汇报的子任务"), /还没有子任务/u);
  assert.equal(await chat("删掉准备面试"), "已删除「准备面试」及其 1 条子任务。");
  const stored = (await request("GET", "/api/tasks")).body;
  assert.deepEqual(
    stored.map(({ title }: { title: string }) => title),
    ["准备汇报"],
  );
});

test("任务 API 校验元数据、创建关联子任务并保持原有响应格式", async (t) => {
  const { request } = await startTestApp(t);
  const path = "/api/tasks";
  const invalid = await request("POST", path, { title: "测试", priority: "urgent" });
  assert.equal(invalid.status, 400);
  const parent = await request("POST", path, { title: "主任务", dueDate: "2028-02-29" });
  assert.equal(parent.status, 201);
  const child = await request("POST", path + "/" + parent.body.id + "/subtasks", {
    title: "子任务",
    priority: "medium",
    effort: "small",
  });
  assert.equal(child.status, 201);
  assert.equal(child.body.parentId, parent.body.id);
  assert.equal(
    (await request("POST", path + "/" + child.body.id + "/subtasks", { title: "测试" })).status,
    404,
  );
  assert.equal(
    (await request("PATCH", path + "/" + child.body.id, { parentId: null })).status,
    400,
  );
  assert.equal(
    (await request("PATCH", path + "/" + child.body.id, { done: true, effort: "large" })).body
      .effort,
    "large",
  );
  assert.equal((await request("DELETE", path + "/" + parent.body.id)).status, 204);
  assert.deepEqual((await request("GET", path)).body, []);
});

test("相对日期跨月跨年，并校验日期有效性", () => {
  assert.equal(resolveDate("明天", "2025-12-31"), "2026-01-01");
  assert.equal(resolveDate("下周一", "2025-12-31"), "2026-01-05");
  assert.equal(resolveDate("本周日", "2025-12-31"), "2026-01-04");
  assert.equal(resolveDate("2025-02-29", "2025-12-31"), undefined);
  assert.equal(resolveDate("toString", "2025-12-31"), undefined);
});

test("招聘方临时改档时，按原日期定位同名面试，原时刻和状态保留", async (t) => {
  const { chat, request, filename } = await startTestApp(t, { live: true });
  const day = today();
  const tomorrow = resolveDate("明天", day);
  const later = resolveDate("后天", day);
  await chat("我明天上午九点有一个面试");
  await chat("下周二下午两点有一个面试");
  const initial = (await request("GET", "/api/tasks")).body;
  assert.equal(initial.length, 2);
  assert.equal(initial[0].dueDate, tomorrow);
  assert.equal(initial[0].dueTime, "09:00");

  const several = await chat("面试挪到后天了");
  assert.match(several, /有 2 条匹配/u);
  const moved = await chat("招聘方刚联系我，明天的面试改到后天了");
  assert.match(moved, /已把「面试」改到.*09:00/u);
  const fresh = await startTestApp(t, { live: true, filename });
  const after = (await fresh.request("GET", "/api/tasks")).body;
  assert.deepEqual(after[0], { ...initial[0], title: "面试", dueDate: later, duePeriod: null });
  assert.deepEqual(after[1], initial[1]);

  const vague = "那场面试挪到下午三点半吧";
  const options = await fresh.chat(vague);
  assert.match(options, /有 2 条匹配/u);
  assert.deepEqual((await fresh.request("GET", "/api/tasks")).body, after);
  assert.match(
    await fresh.chat("第一条", [
      { role: "user", content: vague },
      { role: "assistant", content: options },
    ]),
    /15:30/u,
  );
  const exact = (await fresh.request("GET", "/api/tasks")).body;
  assert.equal(exact[0].dueDate, later);
  assert.equal(exact[0].dueTime, "15:30");
  assert.deepEqual(exact[1], initial[1]);
  assert.match(await fresh.chat("把后天的面试改到25:30"), /哪天或几点/u);
  assert.deepEqual((await fresh.request("GET", "/api/tasks")).body, exact);
});

test("接送、取药和家务可以一起记下，下午和晚上沿用当天日期", async (t) => {
  const { chat, request, filename } = await startTestApp(t, { live: true });
  const user = "明早先送孩子去学校，下午三点去药房拿药，晚上还得洗衣服和给邻居回个电话。";
  const tomorrow = resolveDate("明天", today());
  assert.match(await chat(user), /已添加 4 条待办/u);
  const stored = (await request("GET", "/api/tasks")).body;
  assert.deepEqual(
    stored.map((item: { title: string }) => item.title),
    ["送孩子去学校", "去药房拿药", "洗衣服", "给邻居回个电话"],
  );
  assert.ok(stored.every((item: { dueDate: string }) => item.dueDate === tomorrow));
  assert.equal(stored[1].dueTime, "15:00");
  assert.equal(stored[2].duePeriod, "晚上");
  const fresh = await startTestApp(t, { live: true, filename });
  assert.deepEqual((await fresh.request("GET", "/api/tasks")).body, stored);
  assert.match(await fresh.chat(user), /已经在清单里/u);
  assert.deepEqual((await fresh.request("GET", "/api/tasks")).body, stored);
});

test("一天跑两趟时，购物品项合在一条，已经做过的事和假设不会入清单", async (t) => {
  const { chat, request } = await startTestApp(t, { live: true });
  await chat("昨晚跟物业谈过了，今天下班后得去缴停车费，顺便买西红柿和鸡蛋。");
  await chat("如果能提前下班，晚上去游泳和找朋友吃宵夜。");
  await chat("昨天买菜、洗衣服和打游戏。");
  await chat("今天要去找物业和洗车吗？");
  await chat("周五下班前得把报销单交了，然后去菜站买西红柿和鸡蛋。");
  const saved = (await request("GET", "/api/tasks")).body;
  assert.deepEqual(
    saved.map((item: { title: string }) => item.title),
    ["下班后去缴停车费", "买西红柿和鸡蛋", "下班前把报销单交了", "去菜站买西红柿和鸡蛋"],
  );
  assert.equal(saved[0].dueDate, today());
  assert.equal(saved[1].dueDate, today());
  assert.equal(saved[2].dueDate, resolveDate("周五", today()));
  assert.equal(saved[3].dueDate, saved[2].dueDate);
  assert.match(await chat("今天有哪些任务到期？"), /买西红柿和鸡蛋/u);
});

test("随手输入的生活清单可一次记三条，确认前不会因不完整或混合指令部分写入", async (t) => {
  const { chat, request } = await startTestApp(t, { live: true });
  assert.match(await chat("我见天要吃饭、洗衣服和打游戏"), /已添加 3 条待办/u);
  const saved = (await request("GET", "/api/tasks")).body;
  assert.deepEqual(
    saved.map((item: { title: string }) => item.title),
    ["吃饭", "洗衣服", "打游戏"],
  );
  assert.ok(saved.every((item: { dueDate: string }) => item.dueDate === today()));
  await chat("帮我记一下明天去银行，然后删掉洗衣服");
  assert.deepEqual((await request("GET", "/api/tasks")).body, saved);
  assert.equal(resolveSchedule("明晚八点半", today())?.dueTime, "20:30");
});

test("下班的几种说法都能直接记下缴费、顺路买菜和隔天接猫", async (t) => {
  const forms = [
    ["下班", "下班时"],
    ["晚上下班", "晚上下班时"],
    ["晚上下班的时候", "晚上下班时"],
    ["今天晚上下班的时候", "晚上下班时"],
    ["今天下班的时候", "下班时"],
  ] as const;
  const day = today();
  const nextDay = resolveDate("明天", day);
  for (const [when, period] of forms) {
    const { chat, request } = await startTestApp(t, { live: true });
    const full = when + "缴停车费、顺手买菜、隔天接猫";
    assert.match(await chat(full), /已添加 3 条待办/u);
    const tasks = (await request("GET", "/api/tasks")).body;
    const fields = ({
      title,
      dueDate,
      duePeriod,
      dueTime,
    }: {
      title: string;
      dueDate: string;
      duePeriod?: string;
      dueTime?: string;
    }) => [title, dueDate, duePeriod, dueTime];
    assert.deepEqual(tasks.map(fields), [
      ["缴停车费", day, period, undefined],
      ["买菜", day, period, undefined],
      ["接猫", nextDay, undefined, undefined],
    ]);
    assert.match(await chat(full), /已经在清单里/u);
    assert.deepEqual((await request("GET", "/api/tasks")).body, tasks);
  }
});

test("隔天以已有计划为基准，随后同一天的事不继续递增日期", async (t) => {
  const { chat, request, filename } = await startTestApp(t, { live: true });
  const day = today();
  const friday = resolveDate("周五", day);
  const saturday = resolveDate("次日", day, friday);
  assert.match(await chat("周五下班后去取眼镜、次日拿报告和取干洗的外套"), /已添加 3 条待办/u);
  const stored = (await request("GET", "/api/tasks")).body;
  assert.deepEqual(
    stored.map(({ dueDate }: { dueDate: string }) => dueDate),
    [friday, saturday, saturday],
  );
  assert.equal(stored[0].duePeriod, "下班后");
  const fresh = await startTestApp(t, { live: true, filename });
  assert.match(await fresh.chat("去取眼镜挪到明天下班的时候"), /下班时/u);
  assert.equal((await fresh.request("GET", "/api/tasks")).body[0].duePeriod, "下班时");
});
