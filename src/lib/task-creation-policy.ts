import { WORKSTREAM_PROJECT } from "@/lib/crm";

export const REQUIRED_TASK_DUE = "Choose a due date for a new task. Ideas and subtasks can have no due date.";
/** Creation-only policy: never retroactively changes an existing task. */
export function creationNeedsDue(typeId: string, input: { parentId?: string; isIdea?: boolean }) {
  return typeId === WORKSTREAM_PROJECT && !input.parentId && !input.isIdea;
}
export function validTaskDue(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
