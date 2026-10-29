import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";

export const BASE = process.env.TASKBOARD_URL ?? "http://localhost:3000";
export const OUTBOX = process.env.EMAIL_OUTBOX_DIR ?? ".outbox";
export const PW = "correct-horse-9";
export const SUPER_EMAIL = "root.test@aplyd.com"; // the server must run with SUPER_ADMIN_EMAILS=root.test@aplyd.com
const run = Date.now();
let n = 0;

export class Client {
  cookie = "";
  async call(method: string, p: string, body?: unknown) {
    const res = await fetch(BASE + p, {
      method,
      headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    const json = text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null;
    return { status: res.status, json, setCookie: set, headers: res.headers };
  }
  get = (p: string) => this.call("GET", p);
  post = (p: string, b?: unknown) => this.call("POST", p, b ?? {});
  patch = (p: string, b?: unknown) => this.call("PATCH", p, b);
  put = (p: string, b?: unknown) => this.call("PUT", p, b);
  del = (p: string) => this.call("DELETE", p);
}

function verifyToken(email: string) {
  let files: string[] = [];
  try { files = readdirSync(OUTBOX).sort(); } catch { return null; }
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8"))).filter((m) => m.to === email && /Verify/.test(m.subject));
  return mails.at(-1)?.text.match(/token=([\w-]+)/)?.[1] ?? null;
}

export type Account = { c: Client; id: string; email: string; name: string };

/** A verified, signed-in person. Reuses the account if it already exists. */
export async function account(label: string, fixedEmail?: string, fixedName?: string): Promise<Account> {
  const email = fixedEmail ?? `${label}${run}${n++}@aplyd.com`;
  const name = fixedName ?? label[0].toUpperCase() + label.slice(1);
  const c = new Client();
  const r = await c.post("/api/auth/signup", { name, email, password: PW });
  if (r.status === 201) {
    const t = verifyToken(email);
    expect((await c.post("/api/auth/verify", { token: t })).status).toBe(200);
  }
  const s = await c.post("/api/auth/signin", { email, password: PW });
  expect(s.status).toBe(200);
  return { c, id: s.json.user.id, email, name };
}

export const superAdmin = () => account("root", SUPER_EMAIL);

export async function admin(sa: Account, label = "admin") {
  const a = await account(label);
  expect((await sa.c.patch(`/api/team/${a.id}`, { orgRole: "ADMIN" })).status).toBe(200);
  return a;
}

/** A project led by `leader`, with optional extra members. Returns ids. */
export async function project(creator: Account, leader: Account, members: { who: Account; role?: "EDITOR" | "VIEWER" }[] = [], name?: string) {
  const r = await creator.c.post("/api/projects", { name: name ?? `P${run}-${n++}`, leaderId: leader.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  for (const m of members) {
    expect((await leader.c.post(`/api/projects/${id}/members`, { userId: m.who.id, role: m.role ?? "EDITOR" })).status).toBe(201);
  }
  const p = await leader.c.get(`/api/projects/${id}`);
  const sections = p.json.project.sections as { id: string; name: string; isDone: boolean }[];
  return { id, todo: sections[0].id, doing: sections[1].id, done: sections.find((s) => s.isDone)!.id, sections };
}

export const task = async (who: Account, projectId: string, body: Record<string, unknown> = {}) => {
  const r = await who.c.post(`/api/projects/${projectId}/tasks`, { title: "Task " + n++, dueDate: istDate(1), ...body });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.task.id as string;
  // Preserve legacy undated fixtures without bypassing the new-task API date requirement.
  if (!Object.hasOwn(body, "dueDate") && !body.parentId) {
    const { db } = await import("@/lib/db");
    await db.task.update({ where: { id }, data: { dueDate: null } });
  }
  return id;
};

/** PATCH a task on the version it is at right now (SHO-BUG-13: the server refuses an edit without one). */
export const patchTask = async (who: Account, id: string, body: Record<string, unknown>) => {
  const seen = (await who.c.get(`/api/tasks/${id}`)).json?.task?.updatedAt ?? new Date(0).toISOString();
  return who.c.patch(`/api/tasks/${id}`, { ...body, expectedUpdatedAt: seen });
};

/** The version a task is at right now, as the page would show it (SHO-BUG-13, APL-2668: a change without one is refused). */
export const versionNow = async (who: Account, id: string) => (await who.c.get(`/api/tasks/${id}`)).json?.task?.updatedAt ?? new Date(0).toISOString();

/** A body for assign, move, complete or approver, made on the version the task is at right now. */
export const withVersion = async (who: Account, id: string, body: Record<string, unknown> = {}) => ({ ...body, expectedUpdatedAt: await versionNow(who, id) });

/** A bulk body carrying the version each selected task is at right now. */
export const bulkWithVersions = async (who: Account, taskIds: string[], body: Record<string, unknown>) =>
  ({ taskIds, versions: Object.fromEntries(await Promise.all(taskIds.map(async (id) => [id, await versionNow(who, id)]))), ...body });

export function istDate(offsetDays: number) {
  const ist = new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86400_000);
  return ist.toISOString().slice(0, 10);
}

/** A ZZ-TEST project led by `leader`, named so cleanup and QA can tell it is test data. */
export async function zzProject(leader: Account, label: string) {
  const r = await leader.c.post("/api/projects", { name: `ZZ-TEST ${label}`, leaderId: leader.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.project.id as string;
}

/**
 * Cleans up ZZ-TEST data through the API, as the APL-2522 spec does: the Super Admin takes over as Leader,
 * restores anything left in Trash and archives each project, then deactivates each person.
 * The API has no hard delete for people or projects.
 */
export async function cleanupZz(projectIds: string[], people: Account[]) {
  const sa = await superAdmin();
  const problems: string[] = [];
  for (const id of projectIds) {
    const added = await sa.c.post(`/api/projects/${id}/members`, { userId: sa.id, role: "EDITOR" });
    if (added.status !== 201 && !(added.status === 409 && /already a member/.test(added.json?.error ?? ""))) problems.push(`add member ${id}: ${added.status}`);
    const led = await sa.c.post(`/api/projects/${id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" });
    if (led.status !== 200 && !(led.status === 400 && /already the Leader/.test(led.json?.error ?? ""))) problems.push(`change leader ${id}: ${led.status}`);
    // Bring Trash back first, so a back-dated test task is never left for another test's purge run to count.
    const trash = await sa.c.get(`/api/projects/${id}/trash`);
    for (const item of (trash.json?.items ?? []) as { id: string }[]) {
      const back = await sa.c.post(`/api/tasks/${item.id}/restore`, { confirmParent: true });
      if (back.status >= 300) problems.push(`restore ${item.id}: ${back.status}`);
    }
    const archived = await sa.c.post(`/api/projects/${id}/archive`);
    if (archived.status !== 200) problems.push(`archive ${id}: ${archived.status}`);
  }
  for (const who of people) {
    if (who.id === sa.id) continue;
    const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
    if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) problems.push(`deactivate ${who.email}: ${off.status}`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
}
