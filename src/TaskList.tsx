import { useEffect, useState } from "react";
import {
  effortLabel,
  priorityLabel,
  sortByDueDate,
  taskMetadata,
  isTask,
  type Task,
} from "../shared/tasks.ts";

function TaskEntry({
  task,
  today,
  children = [],
}: {
  task: Task;
  today: string;
  children?: Task[];
}) {
  const { dueDate, priority, effort } = taskMetadata(task);
  const overdue = dueDate && dueDate < today && !task.done;
  const dueToday = dueDate === today && !task.done;
  return (
    <li className="task-entry">
      <div className="task-title">
        <span className={task.done ? "task-state done" : "task-state"}>
          {task.done ? "已完成" : "待办"}
        </span>
        <strong>{task.title}</strong>
      </div>
      {(dueDate || priority || effort || children.length > 0) && (
        <div className="task-labels">
          {dueDate && (
            <span className={overdue ? "overdue" : dueToday ? "due-today" : ""}>
              {overdue ? "逾期" : dueToday ? "今天到期" : "截止"}{" "}
              <time dateTime={dueDate}>{dueDate}</time>
            </span>
          )}
          {priority && (
            <span className={priority === "high" ? "high-priority" : ""}>
              优先级{priorityLabel[priority]}
            </span>
          )}
          {effort && <span>工作量{effortLabel[effort]}</span>}
          {children.length > 0 && (
            <span>
              子任务 {children.filter((child) => child.done).length}/{children.length}
            </span>
          )}
        </div>
      )}
      {children.length > 0 && (
        <ul className="subtask-list" aria-label="子任务">
          {children.map((child) => (
            <TaskEntry key={child.id} task={child} today={today} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function TaskList({ revision, open }: { revision: number; open: boolean }) {
  const [snapshot, setSnapshot] = useState<{ tasks: Task[]; today: string }>();
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/tasks", {
          signal: controller.signal,
          cache: "no-store",
        });
        if (!response.ok) throw new Error("Task list unavailable");
        const tasks: unknown = await response.json();
        if (!Array.isArray(tasks) || !tasks.every(isTask)) throw new Error("Invalid task list");
        if (controller.signal.aborted) return;
        setSnapshot({ tasks, today: response.headers.get("X-Todo-Today") ?? "" });
        setError(false);
      } catch {
        if (!controller.signal.aborted) setError(true);
      }
    }
    void load();
    return () => controller.abort();
  }, [revision]);

  const tasks = snapshot?.tasks ?? [];
  const today = snapshot?.today ?? "";
  const parentIds = new Set(
    tasks.filter((task) => typeof task.parentId !== "string").map((task) => task.id),
  );
  const entries = [];
  const children = new Map<string, Task[]>();
  for (const task of sortByDueDate(tasks)) {
    if (typeof task.parentId === "string" && parentIds.has(task.parentId)) {
      const siblings = children.get(task.parentId) ?? [];
      siblings.push(task);
      children.set(task.parentId, siblings);
    } else {
      entries.push(task);
    }
  }
  const pending = entries.filter(
    (task) => !task.done || children.get(task.id)?.some((child) => !child.done),
  );
  const pendingIds = new Set(pending.map((task) => task.id));
  const done = entries.filter((task) => !pendingIds.has(task.id));
  const dueDates = tasks.filter((task) => !task.done).map((task) => taskMetadata(task).dueDate);
  const dueToday = dueDates.filter((date) => date === today).length;
  const overdue = dueDates.filter((date) => date && date < today).length;

  return (
    <aside
      id="task-list"
      className={open ? "task-panel is-open" : "task-panel"}
      aria-label="任务清单"
    >
      <h2>任务清单</h2>
      {error && <p role="alert">任务清单加载失败。</p>}
      {!snapshot && !error && <p role="status">正在加载清单…</p>}
      {snapshot && (
        <>
          <p className="task-summary">
            <span>{dueDates.length} 条待处理</span>
            {dueToday > 0 && <span className="due-today">{dueToday} 条今天到期</span>}
            {overdue > 0 && <span className="overdue">{overdue} 条逾期</span>}
          </p>
          <section aria-label="待处理任务">
            <h3>待处理</h3>
            {pending.length ? (
              <ul className="task-entries">
                {pending.map((task) => (
                  <TaskEntry
                    key={task.id}
                    task={task}
                    today={today}
                    children={children.get(task.id)}
                  />
                ))}
              </ul>
            ) : (
              <p className="task-empty">没有待处理的任务。</p>
            )}
          </section>
          {done.length > 0 && (
            <details className="completed-tasks">
              <summary>已完成的任务组（{done.length}）</summary>
              <ul className="task-entries">
                {done.map((task) => (
                  <TaskEntry
                    key={task.id}
                    task={task}
                    today={today}
                    children={children.get(task.id)}
                  />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </aside>
  );
}
