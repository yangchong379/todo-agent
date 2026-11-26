import { Router } from "express";
import { z } from "zod";
import { taskMetadataSchema } from "./task-schema.ts";
import { today } from "./task-dates.ts";
import { taskTitleSchema, type TaskStore } from "./task-store.ts";

const createTaskSchema = z.strictObject({ title: taskTitleSchema, ...taskMetadataSchema.shape });
const updateTaskSchema = createTaskSchema
  .partial()
  .extend({ done: z.boolean().optional() })
  .refine((changes) => Object.keys(changes).length > 0);

const taskNotFound = { error: "找不到这条任务。" };

export function taskRouter(tasks: TaskStore) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.set("X-Todo-Today", today()).json(tasks.list());
  });

  router.post("/", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供有效的任务标题、截止日、优先级或工作量。" });
    }
    const { title, ...details } = input.data;
    res.status(201).json(tasks.create(title, details));
  });

  router.post("/:id/subtasks", (req, res) => {
    const input = createTaskSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: "请提供有效的子任务字段。" });
    const { title, ...details } = input.data;
    const child = tasks.createSubtask(req.params.id, title, details);
    if (!child) return res.status(404).json({ error: "找不到可添加子任务的主任务。" });
    res.status(201).json(child);
  });

  router.patch("/:id", (req, res) => {
    const input = updateTaskSchema.safeParse(req.body);
    if (!input.success) {
      return res.status(400).json({ error: "请提供有效的任务更新字段。" });
    }

    const updated = tasks.update(req.params.id, input.data);
    if (!updated) return res.status(404).json(taskNotFound);
    res.json(updated);
  });

  router.delete("/:id", (req, res) => {
    if (!tasks.remove(req.params.id)) return res.status(404).json(taskNotFound);
    res.sendStatus(204);
  });

  return router;
}
