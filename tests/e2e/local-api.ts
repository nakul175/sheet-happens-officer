// API helpers for the Playwright story specs that drive a LOCAL server with a test database (APL-2624, APL-2721, APL-2737).
// The same calls as tests/helpers.ts and tests/zz-test-data.ts, without vitest: Playwright fails to load a story spec that
// reaches vitest, and then collects 0 tests (APL-2761, APL-2911). Failures throw with the server's answer instead of expect().
// Local only: PW is the throwaway password of the local test accounts, the same one tests/helpers.ts uses.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const BASE = process.env.TASKBOARD_URL ?? "http://localhost:3000";
export const OUTBOX = process.env.EMAIL_OUTBOX_DIR ?? ".outbox";
export const PW = "correct-horse-9";
export const SUPER_EMAIL = "root.test@aplyd.com"; // the server must run with SUPER_ADMIN_EMAILS=root.test@aplyd.com

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped API JSON, as in tests/helpers.ts
type Json = any;
export type Reply = { status: number; json: Json };

export class Client {
  cookie = "";
  async call(method: string, p: string, body?: unknown): Promise<Reply> {
    const res = await fetch(BASE + p, {
      method,
      headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    const json = text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null;
    return { status: res.status, json };
  }
  get = (p: string) => this.call("GET", p);
  post = (p: string, b?: unknown) => this.call("POST", p, b ?? {});
  patch = (p: string, b?: unknown) => this.call("PATCH", p, b);
  put = (p: string, b?: unknown) => this.call("PUT", p, b);
  del = (p: string) => this.call("DELETE", p);
}

/** Throws with the server's answer unless `r.status` is `want`. */
export function must(r: Reply, want: number, what: string): Reply {
  if (r.status !== want) throw new Error(`${what}: expected ${want}, got ${r.status} ${JSON.stringify(r.json)}`);
  return r;
}

function verifyToken(email: string) {
  let files: string[] = [];
  try { files = readdirSync(OUTBOX).sort(); } catch { return null; }
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8")));
  return mails.filter((m) => m.to === email && /Verify/.test(m.subject)).at(-1)?.text.match(/token=([\w-]+)/)?.[1] ?? null;
}

export type Account = { c: Client; id: string; email: string; name: string };

/** A verified, signed-in person. Reuses the account if it already exists. */
export async function account(name: string, email: string): Promise<Account> {
  const c = new Client();
  const r = await c.post("/api/auth/signup", { name, email, password: PW });
  if (r.status === 201) must(await c.post("/api/auth/verify", { token: verifyToken(email) }), 200, `verify ${email}`);
  const s = must(await c.post("/api/auth/signin", { email, password: PW }), 200, `sign in ${email}`);
  return { c, id: s.json.user.id, email, name };
}

export const superAdmin = () => account("Root", SUPER_EMAIL);

function defaultDue() {
  return new Date(Date.now() + 5.5 * 3600_000 + 3 * 86400_000).toISOString().slice(0, 10);
}

export async function task(who: Account, projectId: string, body: Record<string, unknown>) {
  // SHO-3037: a new top-level task needs a due date. Subtasks and an explicit dueDate are left alone.
  const dated = body.parentId || "dueDate" in body ? body : { dueDate: defaultDue(), ...body };
  const r = must(await who.c.post(`/api/projects/${projectId}/tasks`, dated), 201, "create task");
  return r.json.task.id as string;
}

/** The version a task is at right now (SHO-BUG-13, APL-2668: a change without one is refused). */
export const versionNow = async (who: Account, id: string) => (await who.c.get(`/api/tasks/${id}`)).json?.task?.updatedAt ?? new Date(0).toISOString();

/** A body for assign, move, complete or approver, made on the version the task is at right now. */
export const withVersion = async (who: Account, id: string, body: Record<string, unknown> = {}) => ({ ...body, expectedUpdatedAt: await versionNow(who, id) });

/** PATCH a task on the version it is at right now. */
export const patchTask = async (who: Account, id: string, body: Record<string, unknown>) =>
  who.c.patch(`/api/tasks/${id}`, { ...body, expectedUpdatedAt: await versionNow(who, id) });

export type ZzProject = { id: string; name: string; todo: string; doing: string; done: string };

/**
 * ZZ-TEST people and projects for one spec, cleaned up through the API, as tests/zz-test-data.ts does:
 * the Super Admin joins each project, takes the Leader role and archives it, deactivates each person, then signs out.
 */
export function zzTestData(tag: string) {
  const run = `${Date.now().toString(36)}${process.pid.toString(36)}`;
  let seq = 0;
  const people: Account[] = [];
  const projectIds: string[] = [];

  async function person(role: string) {
    const n = seq++;
    const slug = role.toLowerCase().replace(/[^a-z0-9]+/g, "") || "user";
    const who = await account(`ZZ-TEST ${role}`, `nakul17+zz-${tag}-${run}-${slug}-${n}@aplyd.com`);
    people.push(who);
    return who;
  }

  async function project(leader: Account): Promise<ZzProject> {
    const name = `ZZ-TEST ${run}-${seq++}`;
    const r = must(await leader.c.post("/api/projects", { name, leaderId: leader.id }), 201, "create project");
    const id = r.json.project.id as string;
    projectIds.push(id);
    const p = await leader.c.get(`/api/projects/${id}`);
    const sections = p.json.project.sections as { id: string; name: string; isDone: boolean }[];
    return { id, name, todo: sections[0].id, doing: sections[1].id, done: sections.find((s) => s.isDone)!.id };
  }

  /** Returns what went wrong, if anything. */
  async function cleanUp() {
    const sa = await superAdmin();
    const problems: string[] = [];
    for (const id of projectIds) {
      const added = await sa.c.post(`/api/projects/${id}/members`, { userId: sa.id, role: "EDITOR" });
      if (added.status !== 201 && !(added.status === 409 && /already a member/.test(added.json?.error ?? ""))) {
        problems.push(`add member ${id}: ${added.status} ${JSON.stringify(added.json)}`);
      }
      const led = await sa.c.post(`/api/projects/${id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" });
      if (led.status !== 200 && !(led.status === 400 && /already the Leader/.test(led.json?.error ?? ""))) {
        problems.push(`change leader ${id}: ${led.status} ${JSON.stringify(led.json)}`);
      }
      const archived = await sa.c.post(`/api/projects/${id}/archive`);
      if (archived.status !== 200) problems.push(`archive ${id}: ${archived.status} ${JSON.stringify(archived.json)}`);
    }
    for (const who of people) {
      const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
      if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) {
        problems.push(`deactivate ${who.email}: ${off.status} ${JSON.stringify(off.json)}`);
      }
    }
    const out = await sa.c.post("/api/auth/signout");
    if (out.status !== 204) problems.push(`sign out ${sa.email}: ${out.status} ${JSON.stringify(out.json)}`);
    return problems;
  }

  return { person, project, cleanUp };
}
