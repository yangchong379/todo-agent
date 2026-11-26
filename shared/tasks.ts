export interface Task {
  id: string;
  title: string;
  done: boolean;
  [key: string]: unknown;
}

export const dayPeriods = ["凌晨", "早上", "上午", "中午", "下午", "傍晚", "晚上", "夜里"] as const;
export type DayPeriod = (typeof dayPeriods)[number];

export function isDayPeriod(value: unknown): value is DayPeriod {
  return dayPeriods.some((period) => value === period);
}

export const priorityLabel = { high: "高", medium: "中", low: "低" } as const;
export const effortLabel = { small: "小", medium: "中", large: "大" } as const;

export function isTask(value: unknown): value is Task {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "title" in value &&
    typeof value.title === "string" &&
    "done" in value &&
    typeof value.done === "boolean"
  );
}

export function isTaskDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function taskMetadata(task: Task) {
  const { dueDate, dueTime, duePeriod, priority, effort } = task;
  return {
    dueDate: isTaskDate(dueDate) ? dueDate : undefined,
    dueTime:
      typeof dueTime === "string" && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u.test(dueTime)
        ? dueTime
        : undefined,
    duePeriod: isDayPeriod(duePeriod) ? duePeriod : undefined,
    priority:
      priority === "high" || priority === "medium" || priority === "low" ? priority : undefined,
    effort: effort === "small" || effort === "medium" || effort === "large" ? effort : undefined,
  } as const;
}

export function sortByDueDate(tasks: Task[]) {
  const rank = { high: 0, medium: 1, low: 2 };
  return tasks.toSorted((first, second) => {
    const a = taskMetadata(first);
    const b = taskMetadata(second);
    if (a.dueDate !== b.dueDate) {
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    }
    if (a.dueTime !== b.dueTime) return (a.dueTime ?? "24:00").localeCompare(b.dueTime ?? "24:00");
    return (a.priority ? rank[a.priority] : 3) - (b.priority ? rank[b.priority] : 3);
  });
}
