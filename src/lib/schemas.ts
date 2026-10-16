import { z } from "zod";

export const taskStatus = z.enum(["TODO", "IN_PROGRESS", "BLOCKED", "DONE"]);
export const taskPriority = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]);

const isoDate = z.iso.datetime({ offset: true }).transform((s) => new Date(s));

export const sessionInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  name: z.string().trim().min(1).max(100).optional(),
});

export const projectCreate = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullish(),
});

export const projectUpdate = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(5000).nullish(),
  archived: z.boolean().optional(),
});

export const taskCreate = z.object({
  projectId: z.string().min(1),
  parentId: z.string().min(1).nullish(),
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(20000).nullish(),
  status: taskStatus.optional(),
  priority: taskPriority.optional(),
  dueDate: isoDate.nullish(),
  assigneeIds: z.array(z.string().min(1)).max(50).optional(),
});

export const taskUpdate = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().trim().max(20000).nullish(),
  status: taskStatus.optional(),
  priority: taskPriority.optional(),
  dueDate: isoDate.nullish(),
  projectId: z.string().min(1).optional(),
  // Move within a column: caller supplies the neighbours' ids; server computes position.
  beforeId: z.string().min(1).optional(),
  afterId: z.string().min(1).optional(),
});

export const taskQuery = z.object({
  projectId: z.string().min(1).optional(),
  status: taskStatus.optional(),
  assigneeId: z.string().min(1).optional(),
  parentId: z.string().min(1).optional(),
  topLevel: z.enum(["true", "false"]).optional(),
  dueBefore: isoDate.optional(),
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().min(1).optional(),
});

export const assigneeSet = z.object({
  userIds: z.array(z.string().min(1)).max(50),
});
