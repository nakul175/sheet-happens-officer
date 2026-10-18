// Helpers shared by the E3 (projects) and E4 (tasks) story specs. Credentials come from the environment through ../support.
import { expect, zz, type Api } from "./support";
import type { Page } from "@playwright/test";

export type Who = { page: Page; api: Api; user: Record<string, any> };

/** A date in India time, `off` days from today, as YYYY-MM-DD. */
export const ymd = (off: number) => new Date(Date.now() + 5.5 * 3600_000 + off * 86400_000).toISOString().slice(0, 10);

export type Proj = { id: string; name: string; todo: string; doing: string; done: string };

/**
 * A ZZ-TEST project led by `leader` (default: the Super Admin). Optional `members` are added with their role.
 * It is archived afterwards (the Super Admin may archive anything), so it leaves every active list.
 */
export async function newProject(
  admin: Who,
  later: (fn: () => Promise<unknown>) => void,
  o: { label: string; leader?: Who; creator?: Who; members?: { who: Who; role?: "EDITOR" | "VIEWER" }[] },
): Promise<Proj> {
  const name = zz(o.label);
  const creator = o.creator ?? admin;
  const leader = o.leader ?? admin;
  const r = await creator.api.post("/api/projects", { name, leaderId: leader.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  for (const m of o.members ?? []) {
    const a = await admin.api.post(`/api/projects/${id}/members`, { userId: m.who.user.id, role: m.role ?? "EDITOR" });
    expect(a.status, JSON.stringify(a.json)).toBe(201);
  }
  const d = (await admin.api.get(`/api/projects/${id}`)).json.project;
  const secs = d.sections as { id: string; name: string; isDone: boolean }[];
  return { id, name, todo: secs[0].id, doing: secs[1].id, done: secs.find((s) => s.isDone)!.id };
}

export async function newTask(who: Who, projectId: string, body: Record<string, unknown> = {}) {
  const r = await who.api.post(`/api/projects/${projectId}/tasks`, { title: zz("task"), ...body });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
}

export const getTask = async (who: Who, id: string) => (await who.api.get(`/api/tasks/${id}`)).json.task as Record<string, any>;

let ghosts = 0;
/**
 * A ZZ-TEST person nobody can sign in as (the address is on the reserved .invalid domain, so no real mailbox gets mail).
 * Deactivated afterwards. Use it as "a person who is not in the project".
 */
export async function ghost(admin: Who, later: (fn: () => Promise<unknown>) => void, label = "ghost") {
  const { RUN } = await import("./support");
  const email = `zz-test-${RUN}-${label}${ghosts++}@example.invalid`;
  const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `${label} ${RUN}`, email, role: "MEMBER" });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.person.id as string;
  later(() => admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }));
  return { id, email };
}
