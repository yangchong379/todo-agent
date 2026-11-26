import type { TaskMetadata } from "./task-schema.ts";

export type TaskCommand =
  | { action: "due"; period: "today" | "overdue" }
  | { action: "createSubtask"; parent: string; title: string }
  | { action: "listSubtasks"; parent: string }
  | { action: "renameSubtask"; parent: string; title: string; newTitle: string }
  | {
      action: "changeSubtask";
      parent: string;
      title: string;
      operation: "complete" | "delete" | "reopen";
    }
  | { action: "editTask"; target: string; field: "截止日期" | "优先级" | "工作量"; value: string };

const addSubtask =
  /^(?:帮我|请)?(?:给|为)(?<parent>.+?)\s*(?:添加|新增|加(?:一?[个条项])?)\s*(?:一?[个条项])?子任务\s*[:：]?\s*(?<title>.*)$/u;
const listSubtasks = /^(?:帮我)?(?:看看|查看|列出)\s*(?<parent>.+?)\s*的子任务(?:吧)?$/u;
const changeSubtask =
  /^(?:帮我)?(?<operation>完成|删除|删掉|恢复|重新打开)\s*(?<parent>.+?)\s*的子任务\s*[:：]?\s*(?<title>.+)$/u;
const changeSubtaskLast =
  /^(?:帮我)?(?:把|将)\s*(?<parent>.+?)\s*的子任务\s*[:：]?\s*(?<title>.+?)\s*(?<operation>删掉|删除|拿掉|标(?:记)?为(?:已完成|未完成))(?:吧)?$/u;
const renameSubtask =
  /^(?:帮我)?(?:把|将)\s*(?<parent>.+?)\s*的子任务\s*[:：]?\s*(?<title>.+?)\s*(?:改名为|重命名为)\s*(?<newTitle>.+)$/u;
const editTask =
  /^(?:帮我|给我)?(?:把|将)?\s*(?<target>.+?)\s*(?:的)?(?<field>截止日期|截止日|截止时间|优先级|工作量)\s*(?:设为|改为|设置为|调整为|标为|是|[:：])\s*(?<value>.+)$/u;
const editDeadline =
  /^(?:帮我)?(?:把|将)\s*(?<target>.+?)\s*(?:设为|改为|设置为)\s*(?<value>.+?)(?:到期|截止)$/u;

function name(text: string) {
  return text.trim().replace(/^(?:「(.+)」|“(.+)”|"(.+)")$/u, (_match, a, b, c) => a ?? b ?? c);
}

export function parseTaskCommand(text: string): TaskCommand | undefined {
  if (
    /^(?:我)?(?:今天(?:有(?:哪些|什么)?|有哪些)|有哪些今天)(?:到期的|要到期的)?(?:任务|待办)(?:会?到期)?(?:吗)?$/u.test(
      text,
    ) &&
    text.includes("到期")
  ) {
    return { action: "due", period: "today" };
  }
  if (/^(?:今天到期的(?:任务|待办)|(?:看看|查看|列出)今天到期的(?:任务|待办))$/u.test(text)) {
    return { action: "due", period: "today" };
  }
  if (
    /^(?:我)?(?:有哪些|还有哪些|查看|看看|列出)(?:已经)?(?:逾期|过期)(?:的)?(?:任务|待办)$/u.test(
      text,
    )
  ) {
    return { action: "due", period: "overdue" };
  }
  const add = addSubtask.exec(text)?.groups;
  if (add) return { action: "createSubtask", parent: name(add.parent), title: name(add.title) };
  const list = listSubtasks.exec(text)?.groups;
  if (list) return { action: "listSubtasks", parent: name(list.parent) };
  const rename = renameSubtask.exec(text)?.groups;
  if (rename)
    return {
      action: "renameSubtask",
      parent: name(rename.parent),
      title: name(rename.title),
      newTitle: name(rename.newTitle),
    };
  const change = (changeSubtask.exec(text) ?? changeSubtaskLast.exec(text))?.groups;
  if (change) {
    const operation =
      change.operation === "完成" || change.operation.endsWith("已完成")
        ? "complete"
        : /^(?:删除|删掉|拿掉)$/u.test(change.operation)
          ? "delete"
          : "reopen";
    return {
      action: "changeSubtask",
      parent: name(change.parent),
      title: name(change.title),
      operation,
    };
  }
  const edit = editTask.exec(text)?.groups;
  if (edit) {
    const field = edit.field === "优先级" || edit.field === "工作量" ? edit.field : "截止日期";
    return { action: "editTask", target: name(edit.target), field, value: name(edit.value) };
  }
  const date = editDeadline.exec(text)?.groups;
  if (date)
    return {
      action: "editTask",
      target: name(date.target),
      field: "截止日期",
      value: name(date.value),
    };
}

export function labelsToMetadata(
  field: "优先级" | "工作量",
  value: string,
): TaskMetadata | undefined {
  if (/^(?:无|清除|未设置)$/u.test(value))
    return field === "优先级" ? { priority: null } : { effort: null };
  if (field === "优先级") {
    const priority = { 高: "high", 中: "medium", 低: "low" } as const;
    const label = value.replace(/优先级$/u, "").trim();
    if (label === "高" || label === "中" || label === "低") return { priority: priority[label] };
  } else {
    const effort = { 小: "small", 中: "medium", 大: "large" } as const;
    const label = value.replace(/工作量$/u, "").trim();
    if (label === "小" || label === "中" || label === "大") return { effort: effort[label] };
  }
}
