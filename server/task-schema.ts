import { z } from "zod";

export const taskTitleSchema = z.string().trim().min(1).max(200);
export const taskSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
});
export const taskMetadataSchema = z.strictObject({
  dueDate: z.iso.date().nullable().optional(),
  priority: z.enum(["high", "medium", "low"]).nullable().optional(),
  effort: z.enum(["small", "medium", "large"]).nullable().optional(),
});
export type TaskMetadata = z.infer<typeof taskMetadataSchema>;
