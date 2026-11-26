import { createHash } from "node:crypto";
import type { ChatMessage } from "../shared/chat.ts";
import { interpret } from "./intent.ts";
import { taskTitleSchema, type Task, type TaskStore } from "./task-store.ts";

export type { ChatMessage } from "../shared/chat.ts";

type Mutation = "complete" | "delete";

interface Clarification {
  action: Mutation;
  candidates: Task[];
}

function conversationKey(messages: ChatMessage[]) {
  const turns = messages.map(({ role, content }) => [role, content]);
  return createHash("sha256").update(JSON.stringify(turns)).digest("hex");
}

function choiceNumber(content: string) {
  const choice =
    /^(?:选\s*)?(?:第\s*)?([0-9]+|[一二三四五六七八九十两])\s*(?:条|项|个)?[。！!]?$/u.exec(
      content.normalize("NFKC"),
    )?.[1];
  if (!choice) return undefined;
  if (choice === "两") return 2;
  return /^[0-9]+$/u.test(choice) ? Number(choice) : "一二三四五六七八九十".indexOf(choice) + 1;
}

function normalize(title: string) {
  return title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\s]/gu, "");
}

function findTasks(tasks: Task[], target: string, complete: boolean) {
  const savedTitle = tasks.filter((task) => task.title === target);
  if (savedTitle.length) return savedTitle;

  const name = normalize(target);
  if (!name) return [];

  const titles = tasks.map((task) => ({ task, name: normalize(task.title) }));
  const exact = titles.filter((item) => item.name === name);
  if (exact.length) return exact.map(({ task }) => task);

  if (complete) {
    if (/^(?:会|会议|开会|开会议)$/u.test(name)) {
      return titles
        .filter(
          (item) =>
            /(?:有(?:一?[个场次])?|开(?:一?[个场次])?|参加)(?:会|.*?(?:会议|例会|周会|早会|组会|家长会))(?:要(?:开|参加))?$/u.test(
              item.name,
            ) && !/(?:准备|取消|安排|推迟)会/u.test(item.name),
        )
        .map(({ task }) => task);
    }
    // 例如「牛奶买好了」去掉完成语气后，按动词在前的词序匹配「买牛奶」。
    const reordered = titles.filter(
      (item) => item.name.length === name.length && (name + name).includes(item.name),
    );
    if (reordered.length) return reordered.map(({ task }) => task);
  }

  if ([...name].length < 2) return [];
  return titles.filter((item) => item.name.includes(name)).map(({ task }) => task);
}

function renderList(tasks: Task[], status: "all" | "pending" | "done") {
  const pending = tasks.filter((task) => !task.done);
  const done = tasks.filter((task) => task.done);
  if (status === "all" && tasks.length === 0) return "清单还是空的。";

  const section = (label: string, items: Task[]) =>
    items.length
      ? [`${label}（${items.length}）`, ...items.map((task) => `• ${task.title}`)].join("\n")
      : `暂无${label}任务。`;
  const sections = [];
  if (status !== "done") sections.push(section("待办", pending));
  if (status !== "pending") sections.push(section("已完成", done));
  return sections.join("\n\n");
}

export function createReply(tasks: TaskStore) {
  const clarifications = new Map<string, Clarification | null>();

  function askWhich(messages: ChatMessage[], clarification: Clarification) {
    const { action, candidates } = clarification;
    const verb = action === "delete" ? "删除" : "完成";
    const options = candidates.map(
      (task, index) => `${index + 1}. ${task.done ? "已完成" : "待办"} · 「${task.title}」`,
    );
    const content = `有 ${candidates.length} 条匹配的任务。请回复序号，选择要${verb}哪一条。\n${options.join("\n")}`;
    const key = conversationKey([...messages, { role: "assistant", content }]);
    const existing = clarifications.get(key);
    if (!clarifications.has(key)) {
      clarifications.set(key, clarification);
      if (clarifications.size > 100) {
        const oldest = clarifications.keys().next();
        if (!oldest.done) clarifications.delete(oldest.value);
      }
    } else if (existing?.candidates.some((task, index) => task.id !== candidates[index]?.id)) {
      // 相同的可见对话如果对应不同的任务 ID，要求重新选定，避免按旧序号误删。
      clarifications.set(key, null);
    }
    return content;
  }

  function mutate(action: Mutation, task: Task) {
    if (action === "delete") {
      return tasks.remove(task.id) ? `已删除「${task.title}」。` : "这条任务已不在清单中。";
    }
    if (task.done) return `「${task.title}」已经是已完成状态。`;
    const updated = tasks.update(task.id, { done: true });
    return updated ? `已完成「${updated.title}」。` : "这条任务已不在清单中。";
  }

  return async function reply(messages: ChatMessage[]): Promise<string> {
    const message = messages.at(-1);
    if (message?.role !== "user") return "请告诉我你想管理哪条待办。";

    const number = choiceNumber(message.content);
    if (number !== undefined) {
      const clarification = clarifications.get(conversationKey(messages.slice(0, -1)));
      if (!clarification) return "请先说要操作哪条任务，我列出候选后你就可以选序号。";
      const selected = clarification.candidates[number - 1];
      if (!selected) return askWhich(messages, clarification);
      const task = tasks.list().find((item) => item.id === selected.id);
      if (!task || task.title !== selected.title || task.done !== selected.done) {
        return "刚才选中的任务已经变化，请重新说要操作哪条任务。";
      }
      return mutate(clarification.action, task);
    }

    const intent = await interpret(message.content);
    switch (intent.action) {
      case "create": {
        const title = taskTitleSchema.safeParse(intent.title);
        if (!title.success) return "请提供 1 至 200 个字符的任务标题。";
        const existing = tasks.list().find((task) => !task.done && task.title === title.data);
        if (existing) return `「${existing.title}」已经在待办清单里了。`;
        const created = tasks.create(title.data);
        return `已添加待办「${created.title}」。`;
      }
      case "list":
        return renderList(tasks.list(), intent.status);
      case "keep":
        return `好的，保留「${intent.target}」。`;
      case "complete":
      case "delete": {
        const completing = intent.action === "complete";
        const verb = completing ? "完成" : "删除";
        if (
          !intent.target ||
          /^(?:它|这|这条|那条|这个|那个|这条任务|那条任务|任务|待办)$/u.test(intent.target)
        ) {
          return `你想${verb}哪条任务？请带上任务名称。`;
        }

        const qualifier =
          /^(?<status>待办|未完成|还没完成|已完成|已经完成)的\s*(?<title>.+)$/u.exec(
            intent.target,
          )?.groups;
        const allTasks = tasks.list();
        const available = qualifier
          ? allTasks.filter((task) => task.done === /^(?:已完成|已经完成)$/u.test(qualifier.status))
          : allTasks;
        const matches = findTasks(available, qualifier?.title ?? intent.target, completing);
        const [firstMatch] = matches;
        if (!firstMatch) return `没找到与「${intent.target}」匹配的任务。`;

        const sameTitle = matches.every((item) => item.title === firstMatch.title);
        const unfinished = completing && sameTitle ? matches.filter((item) => !item.done) : [];
        const candidates = unfinished.length ? unfinished : matches;
        if (candidates.length > 1) {
          candidates.sort((left, right) => Number(left.done) - Number(right.done));
          return askWhich(messages, { action: intent.action, candidates });
        }

        return mutate(intent.action, candidates[0]);
      }
      case "unknown":
        return "你可以直接说接下来要做什么，比如「我晚上有个会议」。也可以问「还有哪些事没做」，或说「衣服洗好了」。";
    }
  };
}
