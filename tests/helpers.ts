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
export async function account(label: string, fixedEmail?: string): Promise<Account> {
  const email = fixedEmail ?? `${label}${run}${n++}@aplyd.com`;
  const name = label[0].toUpperCase() + label.slice(1);
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
export async function project(creator: Account, leader: Account, members: { who: Account; role?: "EDITOR" | "VIEWER" }[] = []) {
  const r = await creator.c.post("/api/projects", { name: `P${run}-${n++}`, leaderId: leader.id });
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

export function istDate(offsetDays: number) {
  const ist = new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86400_000);
  return ist.toISOString().slice(0, 10);
}
