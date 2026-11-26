import { z } from "zod";
import { dayPeriods } from "../shared/tasks.ts";

export const taskTitleSchema = z.string().trim().min(1).max(200);
export const taskSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
});
export const taskMetadataSchema = z.strictObject({
  dueDate: z.iso.date().nullable().optional(),
  dueTime: z
    .string()
    .regex(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/u)
    .nullable()
    .optional(),
  duePeriod: z.enum(dayPeriods).nullable().optional(),
  priority: z.enum(["high", "medium", "low"]).nullable().optional(),
  effort: z.enum(["small", "medium", "large"]).nullable().optional(),
});
export type TaskMetadata = z.infer<typeof taskMetadataSchema>;
