import { createHash } from "node:crypto";
import type { ChatMessage } from "../shared/chat.ts";
import { effortLabel, priorityLabel, sortByDueDate, taskMetadata } from "../shared/tasks.ts";
import { interpret } from "./intent.ts";
import { labelsToMetadata } from "./task-commands.ts";
import type { TaskMetadata } from "./task-schema.ts";
import { resolveSchedule, scheduleLabel, splitSchedule, today } from "./task-dates.ts";
import { taskTitleSchema, type Task, type TaskStore } from "./task-store.ts";

export type { ChatMessage } from "../shared/chat.ts";

type Mutation = "complete" | "delete" | "reopen";

interface Clarification {
  verb: string;
  candidates: Task[];
  execute(task: Task): string;
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

function findTasks(
  tasks: Task[],
  target: string,
  complete: boolean,
  titleOf: (task: Task) => string = (task) => task.title,
) {
  const savedTitle = tasks.filter((task) => titleOf(task) === target);
  if (savedTitle.length) return savedTitle;

  const name = normalize(target);
  if (!name) return [];

  const titles = tasks.map((task) => ({ task, name: normalize(titleOf(task)) }));
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

function withoutSchedule(title: string) {
  const prefix = splitSchedule(title);
  const name = prefix?.rest || title;
  return name.replace(/^(?:的\s*|(?:还有|有)(?:一?[个场次]))/u, "").trim() || title;
}

function taskLine(task: Task) {
  const { dueDate, dueTime, duePeriod, priority, effort } = taskMetadata(task);
  const deadline = scheduleLabel(dueDate, dueTime, duePeriod);
  const details = [
    deadline && `截止 ${deadline}`,
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
      const { dueDate, dueTime, duePeriod } = taskMetadata(task);
      const deadline = scheduleLabel(dueDate, dueTime, duePeriod);
      return `${index + 1}. ${task.done ? "已完成" : "待办"} · 「${title}」${deadline ? ` · ${deadline}` : ""}`;
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
    {
      completing = false,
      titleOf,
    }: { completing?: boolean; titleOf?: (task: Task) => string } = {},
  ) {
    const scope = /^(?<status>待办|未完成|还没完成|已完成|已经完成)的\s*(?<title>.+)$/u.exec(
      target,
    )?.groups;
    const done = scope?.status.startsWith("已");
    const matches = findTasks(
      scope ? available.filter((task) => task.done === done) : available,
      scope?.title ?? target,
      completing,
      titleOf,
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

  function dateDetails(
    title: string,
    current = today(),
    when = splitSchedule(title)?.expression,
  ): TaskMetadata | undefined {
    const schedule = when ? resolveSchedule(when, current) : undefined;
    if (!schedule) return undefined;
    const { dueDate, dueTime, period } = schedule;
    return {
      dueDate: dueDate ?? current,
      ...(dueTime ? { dueTime } : period ? { duePeriod: period } : {}),
    };
  }

  function changeSchedule(
    messages: ChatMessage[],
    target: string,
    when: string,
    explicit: boolean,
  ) {
    const current = today();
    const clearing = explicit && /^(?:无|清除|未设置)$/u.test(when);
    const schedule = resolveSchedule(when, current);
    if (!clearing && !schedule) {
      return "请告诉我改到哪天或几点，比如后天下午三点，也可以用 YYYY-MM-DD。";
    }

    const query = target.replace(/^(?:刚才的|刚才那个|那个|那场|这场)\s*/u, "");
    const prefix = splitSchedule(query);
    const remainder = prefix?.rest.replace(/^(?:的|那场|这场)\s*/u, "");
    const previous =
      prefix?.day && remainder ? resolveSchedule(prefix.expression, current) : undefined;
    const available = tasks.list().filter((task) => {
      if (!previous?.dueDate) return true;
      const saved = taskMetadata(task);
      const titleSchedule = splitSchedule(task.title);
      const titleFallback = titleSchedule
        ? resolveSchedule(titleSchedule.expression, current)
        : undefined;
      return (
        (saved.dueDate ?? titleFallback?.dueDate) === previous.dueDate &&
        (!previous.dueTime || (saved.dueTime ?? titleFallback?.dueTime) === previous.dueTime) &&
        (!previous.period ||
          previous.dueTime ||
          (saved.duePeriod ?? titleFallback?.period) === previous.period)
      );
    });
    return chooseTask(
      messages,
      withoutSchedule(previous && remainder ? remainder : query),
      available,
      "改期",
      (task) => {
        const old = taskMetadata(task);
        const inTitle = splitSchedule(task.title);
        const oldTitleTime = inTitle ? resolveSchedule(inTitle.expression, current) : undefined;
        const oldDate = old.dueDate ?? oldTitleTime?.dueDate;
        const oldTime = old.dueTime ?? oldTitleTime?.dueTime;
        const oldPeriod = old.duePeriod ?? oldTitleTime?.period;
        const dueDate = clearing ? null : (schedule?.dueDate ?? oldDate ?? current);
        const dueTime = clearing
          ? null
          : (schedule?.dueTime ?? (schedule?.period ? null : oldTime));
        const duePeriod = clearing || dueTime ? null : (schedule?.period ?? oldPeriod);
        const changed =
          dueDate !== oldDate ||
          (dueTime ?? undefined) !== oldTime ||
          (duePeriod ?? undefined) !== oldPeriod;
        // 旧版会在标题里保存相对时间。改期后去掉旧前缀，日期和时刻由独立字段显示。
        const title = changed && inTitle ? withoutSchedule(task.title) : task.title;
        const updated = tasks.update(task.id, { title, dueDate, dueTime, duePeriod });
        if (!updated) return "这条任务已不在清单中。";
        if (clearing) return `已清除「${updated.title}」的截止日期。`;
        const label = scheduleLabel(
          dueDate ?? undefined,
          dueTime ?? undefined,
          duePeriod ?? undefined,
        );
        return explicit
          ? `已将「${updated.title}」的截止日期设为${label}。`
          : `已把「${updated.title}」改到${label}。`;
      },
      { titleOf: (task) => withoutSchedule(task.title) },
    );
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
      if (
        !task ||
        task.title !== selected.title ||
        task.done !== selected.done ||
        task.dueDate !== selected.dueDate ||
        task.dueTime !== selected.dueTime ||
        task.duePeriod !== selected.duePeriod
      ) {
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
      case "createMany": {
        const current = today();
        const entries = [];
        const skipped = [];
        const seen = new Set(
          tasks
            .list()
            .filter((task) => !task.done && typeof task.parentId !== "string")
            .map((task) => {
              const prefix = splitSchedule(task.title);
              const name = (prefix?.rest || task.title).replace(/^(?:还有|有)(?:一?[个场次])/u, "");
              const { dueDate, dueTime, duePeriod } = taskMetadata(task);
              return JSON.stringify([normalize(name), dueDate, dueTime, duePeriod]);
            }),
        );
        for (const item of intent.items) {
          const title = taskTitleSchema.safeParse(item.title);
          if (!title.success) return "请让每条待办的标题保持在 1 至 200 个字符。";
          const details = dateDetails(title.data, current, item.when);
          if (item.when && !details)
            return `我没认出「${title.data}」的时间「${item.when}」，请换个说法。`;
          const key = JSON.stringify([
            normalize(withoutSchedule(title.data)),
            details?.dueDate,
            details?.dueTime,
            details?.duePeriod,
          ]);
          if (seen.has(key)) {
            skipped.push(title.data);
          } else {
            entries.push({ title: title.data, details });
            seen.add(key);
          }
        }
        const added = tasks.createBatch(entries);
        const response = added.length
          ? `已添加 ${added.length} 条待办：\n${added.map((task) => `• ${taskLine(task)}`).join("\n")}`
          : "这些待办已经在清单里。";
        return added.length && skipped.length
          ? `${response}\n已在清单中：${skipped.join("、")}。`
          : response;
      }
      case "reschedule":
        return changeSchedule(messages, intent.target, intent.when, false);
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
              { completing: intent.operation === "complete" },
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
        if (intent.field === "截止日期")
          return changeSchedule(messages, intent.target, value, true);
        const cleared = /^(?:无|清除|未设置)$/u.test(value);
        const details = labelsToMetadata(intent.field, value);
        if (!details) {
          return {
            优先级: "请使用高、中、低。",
            工作量: "请使用小、中、大。",
          }[intent.field];
        }
        return chooseTask(messages, intent.target, tasks.list(), `更新${intent.field}`, (task) => {
          const updated = tasks.update(task.id, details);
          if (!updated) return "这条任务已不在清单中。";
          return cleared
            ? `已清除「${task.title}」的${intent.field}。`
            : `已将「${task.title}」的${intent.field}设为${value}。`;
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
          { completing },
        );
      }
      case "unknown":
        return "你可以直接说接下来要做什么，比如「明早去拿药，下午得洗衣服」。也可以说「面试改到后天」或问「还有哪些事没做」。";
    }
  };
}
