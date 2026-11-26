import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Task } from "../shared/tasks.ts";
import { taskSchema, type TaskMetadata } from "./task-schema.ts";

export type { Task } from "../shared/tasks.ts";
export { taskTitleSchema } from "./task-schema.ts";

export type TaskChanges = Partial<Pick<Task, "title" | "done">> & TaskMetadata;

export interface NewTask {
  title: string;
  details?: TaskMetadata;
}

export interface TaskStore {
  list(): Task[];
  create(title: string, details?: TaskMetadata): Task;
  createBatch(entries: NewTask[]): Task[];
  createSubtask(parentId: string, title: string, details?: TaskMetadata): Task | undefined;
  update(id: string, changes: TaskChanges): Task | undefined;
  remove(id: string): boolean;
}

export function createJsonTaskStore(filename: string): TaskStore {
  function list(): Task[] {
    if (!existsSync(filename)) return [];
    return taskSchema.array().parse(JSON.parse(readFileSync(filename, "utf8")));
  }

  // 同一服务进程内同步完成读写；替换文件前，原清单始终完整可读。
  function save(tasks: Task[]) {
    mkdirSync(dirname(filename), { recursive: true });
    const temporary = filename + ".tmp";
    writeFileSync(temporary, JSON.stringify(tasks, null, 2) + "\n");
    renameSync(temporary, filename);
  }

  return {
    list,

    create(title, details) {
      const task = { ...details, id: randomUUID(), title, done: false };
      save([...list(), task]);
      return task;
    },

    createBatch(entries) {
      if (!entries.length) return [];
      const added = entries.map(({ title, details }) => ({
        ...details,
        id: randomUUID(),
        title,
        done: false,
      }));
      save([...list(), ...added]);
      return added;
    },

    createSubtask(parentId, title, details) {
      const tasks = list();
      if (!tasks.some((task) => task.id === parentId && typeof task.parentId !== "string")) {
        return undefined;
      }
      const task = { ...details, id: randomUUID(), title, done: false, parentId };
      save([...tasks, task]);
      return task;
    },

    update(id, changes) {
      const tasks = list();
      const task = tasks.find((item) => item.id === id);
      if (!task) return undefined;

      Object.assign(task, changes);
      save(tasks);
      return task;
    },

    remove(id) {
      const tasks = list();
      const remaining = tasks.filter((task) => task.id !== id && task.parentId !== id);
      if (!tasks.some((task) => task.id === id)) return false;

      save(remaining);
      return true;
    },
  };
}
