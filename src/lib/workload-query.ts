import { z } from "zod";
import type { WorkloadMetric } from "@/lib/workload";

/** Reuse 14.9's assignee/f vocabulary. A count opens one matching metric. */
export const workloadQuery = z.object({
  assignee: z.string().min(1).max(60).optional(),
  f: z.enum(["overdue", "blocked", "awaiting"]).optional(),
  due: z.literal("next7").optional(),
  cursor: z.string().min(1).max(60).optional(),
}).refine(q => !q.f || !q.due, "Choose one workload count.")
  .refine(q => !!q.assignee || (!q.f && !q.due && !q.cursor), "Choose a person for the task list.");

export function workloadMetric(query: { f?: string; due?: string }): WorkloadMetric {
  return query.due === "next7" ? "due" : query.f === "awaiting" ? "approval" : query.f === "overdue" ? "overdue" : query.f === "blocked" ? "blocked" : "open";
}
export function workloadHref(personId: string, metric: WorkloadMetric) {
  const q = new URLSearchParams({ assignee: personId });
  if (metric === "due") q.set("due", "next7");
  else if (metric !== "open") q.set("f", metric === "approval" ? "awaiting" : metric);
  return `/workload?${q}`;
}
