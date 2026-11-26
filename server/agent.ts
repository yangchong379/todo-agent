import { createHash } from "node:crypto";
import type { ChatMessage } from "../shared/chat.ts";
import { effortLabel, priorityLabel, sortByDueDate, taskMetadata } from "../shared/tasks.ts";
import { interpret } from "./intent.ts";
import { labelsToMetadata } from "./task-commands.ts";
import { dateExpression, resolveDate, today } from "./task-dates.ts";
import { taskTitleSchema, type Task, type TaskStore } from "./task-store.ts";

export type { ChatMessage } from "../shared/chat.ts";

type Mutation = "complete" | "delete" | "reopen";

interface Clarification {
  verb: string;
  candidates: Task[];
  execute(task: Task): string;
}

const datePrefix = new RegExp("^" + dateExpression.source, "u");

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

function taskLine(task: Task) {
  const { dueDate, priority, effort } = taskMetadata(task);
  const details = [
    dueDate && `截止 ${dueDate}`,
    priority && `优先级${priorityLabel[priority]}`,
    effort && `工作量${effortLabel[effort]}`,
  ].filter(Boolean);
  return task.title + (details.length ? `（${details.join(" · ")}）` : "");
}

function renderList(tasks: Task[], status: "all" | "pending" | "done", allTasks = tasks) {
  const pending = tasks.filter((task) => !task.done);
  const done = tasks.filter((task) => task.done);
  if (status === "all" && tasks.length === 0) return "清单还是空的。";

  function section(label: string, items: Task[]) {
    if (!items.length) return `暂无${label}任务。`;
    const ordered = sortByDueDate(items);
    const parents = new Map(allTasks.map((task) => [task.id, task]));
    const itemIds = new Set(items.map((task) => task.id));
    const children = new Map<string, Task[]>();
    const rows = [];
    for (const task of ordered) {
      const parentId = typeof task.parentId === "string" ? task.parentId : undefined;
      if (parentId && itemIds.has(parentId)) {
        const siblings = children.get(parentId) ?? [];
        siblings.push(task);
        children.set(parentId, siblings);
      } else {
        const parent = parentId ? parents.get(parentId) : undefined;
        rows.push({ task, prefix: parent ? `${parent.title} / ` : "" });
      }
    }
    const lines = rows.flatMap(({ task, prefix }) => [
      `• ${prefix}${taskLine(task)}`,
      ...(children.get(task.id) ?? []).map((child) => `  ↳ ${taskLine(child)}`),
    ]);
    return [`${label}（${items.length}）`, ...lines].join("\n");
  }
  const sections = [];
  if (status !== "done") sections.push(section("待办", pending));
  if (status !== "pending") sections.push(section("已完成", done));
  return sections.join("\n\n");
}

export function createReply(tasks: TaskStore) {
  const clarifications = new Map<string, Clarification | null>();

  function askWhich(messages: ChatMessage[], clarification: Clarification) {
    const { verb, candidates } = clarification;
    const parents = new Map(tasks.list().map((task) => [task.id, task.title]));
    const options = candidates.map((task, index) => {
      const parent = typeof task.parentId === "string" ? parents.get(task.parentId) : undefined;
      const title = parent ? `${parent} / ${task.title}` : task.title;
      return `${index + 1}. ${task.done ? "已完成" : "待办"} · 「${title}」`;
    });
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
      const children = tasks.list().filter((item) => item.parentId === task.id).length;
      if (!tasks.remove(task.id)) return "这条任务已不在清单中。";
      return `已删除「${task.title}」${children ? `及其 ${children} 条子任务` : ""}。`;
    }
    if (action === "reopen") {
      const updated = tasks.update(task.id, { done: false });
      return updated ? `「${task.title}」已恢复为待办。` : "这条任务已不在清单中。";
    }
    if (task.done) return `「${task.title}」已经是已完成状态。`;
    const updated = tasks.update(task.id, { done: true });
    return updated ? `已完成「${updated.title}」。` : "这条任务已不在清单中。";
  }

  function chooseTask(
    messages: ChatMessage[],
    target: string,
    available: Task[],
    verb: string,
    execute: (task: Task) => string,
    completing = false,
  ) {
    const scope = /^(?<status>待办|未完成|还没完成|已完成|已经完成)的\s*(?<title>.+)$/u.exec(
      target,
    )?.groups;
    const done = scope?.status.startsWith("已");
    const matches = findTasks(
      scope ? available.filter((task) => task.done === done) : available,
      scope?.title ?? target,
      completing,
    );
    const [first] = matches;
    if (!first) return `没找到与「${target}」匹配的任务。`;
    const unfinished =
      completing && matches.every((task) => task.title === first.title)
        ? matches.filter((task) => !task.done)
        : [];
    const candidates = unfinished.length ? unfinished : matches;
    if (candidates.length === 1) return execute(candidates[0]);
    candidates.sort((left, right) => Number(left.done) - Number(right.done));
    return askWhich(messages, { verb, candidates, execute });
  }

  function dateDetails(title: string) {
    const prefix = datePrefix.exec(title)?.[0];
    const dueDate = prefix ? resolveDate(prefix, today()) : undefined;
    return dueDate ? { dueDate } : undefined;
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
      return clarification.execute(task);
    }

    const intent = await interpret(message.content);
    switch (intent.action) {
      case "create": {
        const title = taskTitleSchema.safeParse(intent.title);
        if (!title.success) return "请提供 1 至 200 个字符的任务标题。";
        const existing = tasks
          .list()
          .find(
            (task) => !task.done && typeof task.parentId !== "string" && task.title === title.data,
          );
        if (existing) return `「${existing.title}」已经在待办清单里了。`;
        const created = tasks.create(title.data, dateDetails(title.data));
        return `已添加待办「${created.title}」。`;
      }
      case "list":
        return renderList(tasks.list(), intent.status);
      case "due": {
        const current = today();
        const allTasks = tasks.list();
        const due = allTasks.filter((task) => {
          const date = taskMetadata(task).dueDate;
          return (
            date && (intent.period === "today" ? date === current : date < current && !task.done)
          );
        });
        const label = intent.period === "today" ? `今天到期（${current}）` : "逾期未完成";
        if (!due.length)
          return intent.period === "today" ? "今天没有到期的任务。" : "没有逾期未完成的任务。";
        return `${label}\n${renderList(due, intent.period === "today" ? "all" : "pending", allTasks)}`;
      }
      case "createSubtask":
      case "listSubtasks":
      case "renameSubtask":
      case "changeSubtask": {
        const parents = tasks.list().filter((task) => typeof task.parentId !== "string");
        return chooseTask(messages, intent.parent, parents, "操作", (parent) => {
          const children = tasks.list().filter((task) => task.parentId === parent.id);
          if (intent.action === "listSubtasks") {
            return children.length
              ? `「${parent.title}」的子任务\n${renderList(children, "all")}`
              : `「${parent.title}」还没有子任务。`;
          }
          if (intent.action === "changeSubtask") {
            const label = { complete: "完成", delete: "删除", reopen: "恢复" }[intent.operation];
            return chooseTask(
              messages,
              intent.title,
              children,
              label,
              (child) => mutate(intent.operation, child),
              intent.operation === "complete",
            );
          }
          if (intent.action === "renameSubtask") {
            const title = taskTitleSchema.safeParse(intent.newTitle);
            if (!title.success) return "请提供 1 至 200 个字符的新标题。";
            return chooseTask(messages, intent.title, children, "重命名", (child) => {
              const updated = tasks.update(child.id, { title: title.data });
              return updated
                ? `已将子任务「${child.title}」改名为「${updated.title}」。`
                : "这条子任务已不在清单中。";
            });
          }
          const title = taskTitleSchema.safeParse(intent.title);
          if (!title.success) return "请提供 1 至 200 个字符的子任务标题。";
          const duplicate = children.some((task) => !task.done && task.title === title.data);
          if (duplicate) return `「${parent.title}」已有待办子任务「${title.data}」。`;
          const child = tasks.createSubtask(parent.id, title.data, dateDetails(title.data));
          return child
            ? `已为「${parent.title}」添加子任务「${child.title}」。`
            : "找不到可添加子任务的主任务。";
        });
      }
      case "editTask": {
        const value = intent.value.trim();
        const cleared = /^(?:无|清除|未设置)$/u.test(value);
        const date = intent.field === "截止日期" ? resolveDate(value, today()) : undefined;
        const details =
          intent.field === "截止日期"
            ? cleared || date
              ? { dueDate: date ?? null }
              : undefined
            : labelsToMetadata(intent.field, value);
        if (!details) {
          return {
            截止日期: "请使用今天、明天或 YYYY-MM-DD 格式的日期。",
            优先级: "请使用高、中、低。",
            工作量: "请使用小、中、大。",
          }[intent.field];
        }
        return chooseTask(messages, intent.target, tasks.list(), `更新${intent.field}`, (task) => {
          const updated = tasks.update(task.id, details);
          if (!updated) return "这条任务已不在清单中。";
          return cleared
            ? `已清除「${task.title}」的${intent.field}。`
            : `已将「${task.title}」的${intent.field}设为${date ?? value}。`;
        });
      }
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

        return chooseTask(
          messages,
          intent.target,
          tasks.list(),
          verb,
          (task) => mutate(intent.action, task),
          completing,
        );
      }
      case "unknown":
        return "你可以直接说接下来要做什么，比如「我晚上有个会议」。也可以问「还有哪些事没做」，或说「衣服洗好了」。";
    }
  };
}
