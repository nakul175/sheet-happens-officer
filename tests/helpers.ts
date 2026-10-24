import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { outboxDir } from "./e2e/outbox";

export const BASE = process.env.TASKBOARD_URL ?? "http://localhost:3000";
// SHO-2897: no default. `.outbox` against this process's cwd is the same folder every other spec in the run reads,
// so a spec that sent nothing could be satisfied by another spec's mail. Read through outboxDir() (./e2e/outbox.ts),
// which fails loudly naming EMAIL_OUTBOX_DIR. An unset variable therefore leaves this empty, and a reader that uses it
// directly fails instead of reading somebody else's folder.
export const OUTBOX = process.env.EMAIL_OUTBOX_DIR ?? "";
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

/** Longest the fixture waits for the server's outbox write before it reports the reason instead of a 400. */
const MAIL_WAIT_MS = 10_000;

function verifyTokenOnce(email: string) {
  const dir = outboxDir("tests/helpers.ts");
  let files: string[] = [];
  try { files = readdirSync(dir).sort(); } catch { return null; }
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"))).filter((m) => m.to === email && /Verify/.test(m.subject));
  return mails.at(-1)?.text.match(/token=([\w-]+)/)?.[1] ?? null;
}

/**
 * The Verify token for `email`, waiting for the mail to become readable. The mail is written by the *server* process
 * (src/lib/email.ts:63-66 writes into EMAIL_OUTBOX_DIR), so this folder is a condition that becomes true, not a fact
 * that is already true when signup answers. One read turns a mail that has not landed yet - or a folder the server
 * does not write - into a null token, and /api/auth/verify answers 400 "Validation failed" for `token: null`
 * (src/lib/schemas.ts:45), which reads like a product defect instead of a fixture one. Wait on the condition, and when
 * it never holds say which address and which folder were checked; the 200 assertion is unchanged.
 */
async function verifyToken(email: string) {
  const deadline = Date.now() + MAIL_WAIT_MS;
  for (;;) {
    const token = verifyTokenOnce(email);
    if (token) return token;
    if (Date.now() > deadline) return null;
    await new Promise((res) => setTimeout(res, 50));
  }
}

export type Account = { c: Client; id: string; email: string; name: string };

/** A verified, signed-in person. Reuses the account if it already exists. */
export async function account(label: string, fixedEmail?: string, fixedName?: string): Promise<Account> {
  const email = fixedEmail ?? `${label}${run}${n++}@aplyd.com`;
  const name = fixedName ?? label[0].toUpperCase() + label.slice(1);
  const c = new Client();
  const r = await c.post("/api/auth/signup", { name, email, password: PW });
  if (r.status === 201) {
    const t = await verifyToken(email);
    expect(t, `no Verify mail for ${email} in EMAIL_OUTBOX_DIR=${OUTBOX} after ${MAIL_WAIT_MS}ms: the test process and the server must read and write the same folder`).toBeTruthy();
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
  const r = await who.c.post(`/api/projects/${projectId}/tasks`, { title: "Task " + n++, ...body });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
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
