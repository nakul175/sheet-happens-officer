// APL-2875: a caller who cannot see a task gets exactly the answer for a missing id, on every /api/tasks/:id route.
// Test data: ZZ-TEST names and nakul17+ aliases. Projects are archived and people deactivated through the API afterwards.
import { afterAll, describe, expect, it } from "vitest";
import { account, BASE, Client, istDate, superAdmin, type Account } from "./helpers";
import { db } from "../src/lib/db";
import { getTask, taskAccess } from "../src/lib/tasks";

type Res = { status: number; body: string };

const RUN = Date.now().toString(36);
const MISSING = `zz-test-missing-${RUN}`;
const MALFORMED = "{";
const people: Account[] = [];
const projects: { id: string; lead: Account }[] = [];

const person = async (label: string) => {
  const a = await account(label, `nakul17+zz-2875-${label}-${RUN}@aplyd.com`);
  people.push(a);
  return a;
};

/** The raw status and body text, so two answers can be compared byte for byte. */
async function send(cookie: string, method: string, path: string, body?: string): Promise<Res> {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    body,
  });
  return { status: res.status, body: await res.text() };
}

type Route = { method: string; path: (id: string) => string; valid: (s: Seed) => object | undefined; invalid?: object };
type Seed = Awaited<ReturnType<typeof setup>>;

const VERSION = "2020-01-01T00:00:00.000Z";
// Every route under /api/tasks/:id. links and convert are in records.ts and deals.ts, outside this fix.
const ROUTES: Route[] = [
  { method: "GET", path: (id) => `/api/tasks/${id}`, valid: () => undefined },
  { method: "PATCH", path: (id) => `/api/tasks/${id}`, valid: () => ({ title: "ZZ-TEST changed", expectedUpdatedAt: VERSION }), invalid: { title: 7 } },
  { method: "DELETE", path: (id) => `/api/tasks/${id}`, valid: () => undefined },
  { method: "PUT", path: (id) => `/api/tasks/${id}/approver`, valid: (s) => ({ approverId: s.editor.id, expectedUpdatedAt: VERSION }), invalid: { approverId: "" } },
  { method: "POST", path: (id) => `/api/tasks/${id}/assign`, valid: (s) => ({ assigneeId: s.editor.id, expectedUpdatedAt: VERSION }), invalid: { assigneeId: "" } },
  { method: "POST", path: (id) => `/api/tasks/${id}/collaborators`, valid: (s) => ({ userId: s.editor.id }), invalid: { userId: "" } },
  { method: "DELETE", path: (id) => `/api/tasks/${id}/collaborators/zz-test-user`, valid: () => undefined },
  { method: "POST", path: (id) => `/api/tasks/${id}/complete`, valid: () => ({ expectedUpdatedAt: VERSION }), invalid: { completeAll: "yes" } },
  { method: "POST", path: (id) => `/api/tasks/${id}/idea`, valid: () => ({ isIdea: true }), invalid: { isIdea: "yes" } },
  { method: "POST", path: (id) => `/api/tasks/${id}/move`, valid: (s) => ({ sectionId: s.doing, expectedUpdatedAt: VERSION }), invalid: { sectionId: "" } },
  { method: "POST", path: (id) => `/api/tasks/${id}/reopen`, valid: () => ({}), invalid: { sectionId: "" } },
  { method: "POST", path: (id) => `/api/tasks/${id}/restore`, valid: () => ({}), invalid: { confirmParent: "yes" } },
  { method: "POST", path: (id) => `/api/tasks/${id}/send-back`, valid: () => ({}) },
  { method: "POST", path: (id) => `/api/tasks/${id}/send-for-approval`, valid: () => ({}) },
];

/** The bodies each route is tried with: valid, schema-invalid and malformed "{". */
function bodies(r: Route, s: Seed): (string | undefined)[] {
  const v = r.valid(s);
  if (v === undefined) return [undefined];
  return [JSON.stringify(v), ...(r.invalid ? [JSON.stringify(r.invalid)] : []), MALFORMED];
}

async function setup() {
  const lead = await person("lead");
  const editor = await person("editor");
  const viewer = await person("viewer");
  const outsider = await person("outsider");
  const removed = await person("removed");
  const made = await lead.c.post("/api/projects", { name: `ZZ-TEST APL-2875 ${RUN}`, leaderId: lead.id });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const pid = made.json.project.id as string;
  projects.push({ id: pid, lead });
  for (const [who, role] of [[editor, "EDITOR"], [viewer, "VIEWER"], [removed, "EDITOR"]] as const) {
    expect((await lead.c.post(`/api/projects/${pid}/members`, { userId: who.id, role })).status).toBe(201);
  }
  const p = await lead.c.get(`/api/projects/${pid}`);
  const sections = p.json.project.sections as { id: string; isDone: boolean }[];
  const newTask = async (title: string) => {
    const r = await lead.c.post(`/api/projects/${pid}/tasks`, { title, assigneeId: lead.id });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    return r.json.task.id as string;
  };
  const t1 = await newTask(`ZZ-TEST live ${RUN}`);
  const t2 = await newTask(`ZZ-TEST deleted ${RUN}`);
  expect((await lead.c.del(`/api/tasks/${t2}`)).status).toBe(204);
  const left = await lead.c.del(`/api/projects/${pid}/members/${removed.id}`);
  expect(left.status, JSON.stringify(left.json)).toBeLessThan(300);
  return { lead, editor, viewer, outsider, removed, pid, t1, t2, doing: sections[1].id };
}

/** Stored state of the tasks, so a refused call can be shown to change nothing. */
async function snapshot(ids: string[]) {
  const rows = await db.task.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
  return {
    rows: rows.map((t) => ({ id: t.id, updatedAt: t.updatedAt.toISOString(), assigneeId: t.assigneeId, deletedAt: t.deletedAt?.toISOString() ?? null, isIdea: t.isIdea })),
    actions: await db.actionLog.count({ where: { targetId: { in: ids } } }),
    audits: await db.auditLog.count({ where: { targetId: { in: ids } } }),
  };
}

afterAll(async () => {
  for (const p of projects) await p.lead.c.post(`/api/projects/${p.id}/archive`);
  const sa = await superAdmin();
  for (const a of people) await sa.c.post(`/api/team/${a.id}/deactivate`, { reassign: "leaders" });
});

describe("qa:TC missing APL-2875 a caller who cannot see a task gets the missing-id answer", () => {
  it("qa:TC missing AC1: an outsider and a removed member get the missing-id answer for a live task on every task route, and nothing is stored", async () => {
    const s = await setup();
    const before = await snapshot([s.t1, s.t2]);
    for (const who of [s.outsider, s.removed]) {
      for (const r of ROUTES) {
        for (const body of bodies(r, s)) {
          const missing = await send(who.c.cookie, r.method, r.path(MISSING), body);
          const live = await send(who.c.cookie, r.method, r.path(s.t1), body);
          expect(live, `${who.name} ${r.method} ${r.path("T1")} ${body ?? ""}`).toEqual(missing);
          expect(live.body).not.toMatch(/Project not found|ZZ-TEST|nakul17/);
        }
      }
    }
    expect(await snapshot([s.t1, s.t2])).toEqual(before);
  });

  it("qa:TC missing AC1: an outsider gets the missing-id answer for a task in Trash on every task route", async () => {
    const s = await setup();
    const before = await snapshot([s.t2]);
    for (const r of ROUTES) {
      for (const body of bodies(r, s)) {
        const missing = await send(s.outsider.c.cookie, r.method, r.path(MISSING), body);
        const deleted = await send(s.outsider.c.cookie, r.method, r.path(s.t2), body);
        expect(deleted, `${r.method} ${r.path("T2")} ${body ?? ""}`).toEqual(missing);
      }
    }
    expect(await snapshot([s.t2])).toEqual(before);
  });

  it("qa:TC missing AC1: the assign route gives an outsider 404 Task not found for valid, invalid and malformed bodies", async () => {
    const s = await setup();
    for (const body of [JSON.stringify({ assigneeId: s.editor.id, expectedUpdatedAt: VERSION }), JSON.stringify({ assigneeId: "" }), MALFORMED]) {
      for (const id of [s.t1, s.t2, MISSING]) {
        const r = await send(s.outsider.c.cookie, "POST", `/api/tasks/${id}/assign`, body);
        expect(r).toEqual({ status: 404, body: JSON.stringify({ error: "Task not found" }) });
      }
    }
  });

  it("qa:TC missing AC1: a non-admin member of a deal hidden by CRM_VISIBLE=admins gets the missing-id answer", async () => {
    const s = await setup();
    const pipes = await s.lead.c.get("/api/deals/pipelines");
    expect(pipes.status, JSON.stringify(pipes.json)).toBe(200);
    const pipeline = pipes.json.pipelines.find((p: { key: string }) => p.key === "DEAL_PROACTIVE");
    const org = await s.lead.c.post("/api/orgs", { name: `ZZ-TEST APL-2875 buyer ${RUN}` });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    const deal = await s.lead.c.post("/api/deals", {
      name: `ZZ-TEST APL-2875 deal ${RUN}`, organisationId: org.json.organisation.id, pipelineId: pipeline.id,
      leaderId: s.lead.id, whyPursue: "ZZ-TEST", nextStep: { title: "ZZ-TEST call", dueDate: istDate(3) },
    });
    expect(deal.status, JSON.stringify(deal.json)).toBe(201);
    const dealId = deal.json.deal.id as string;
    projects.push({ id: dealId, lead: s.lead });
    expect((await s.lead.c.post(`/api/projects/${dealId}/members`, { userId: s.editor.id, role: "EDITOR" })).status).toBe(201);
    const t3 = await s.lead.c.post(`/api/projects/${dealId}/tasks`, { title: `ZZ-TEST deal task ${RUN}`, assigneeId: s.lead.id });
    expect(t3.status, JSON.stringify(t3.json)).toBe(201);

    const member = { id: s.editor.id, orgRole: "MEMBER" as const };
    const was = process.env.CRM_VISIBLE;
    process.env.CRM_VISIBLE = "admins";
    try {
      const missing = await getTask(member, MISSING).catch((e) => e);
      const hidden = await getTask(member, t3.json.task.id).catch((e) => e);
      expect({ status: hidden.status, message: hidden.message }).toEqual({ status: missing.status, message: missing.message });
      expect(hidden).toMatchObject({ status: 404, message: "Task not found" });
      // The assign route asks taskAccess directly before it reads the body.
      await expect(taskAccess(member, dealId, { write: true })).rejects.toMatchObject({ status: 404, message: "Task not found" });
    } finally {
      if (was === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = was;
    }
  });

  it("qa:TC missing AC2: members keep today's answers", async () => {
    const s = await setup();
    const assign = (who: Account, body: string) => send(who.c.cookie, "POST", `/api/tasks/${s.t1}/assign`, body);
    expect(await assign(s.viewer, JSON.stringify({ assigneeId: s.editor.id, expectedUpdatedAt: VERSION })))
      .toEqual({ status: 403, body: JSON.stringify({ error: "Viewers cannot make changes." }) });
    expect((await s.editor.c.get(`/api/tasks/${s.t1}`)).status).toBe(200);
    const bad = await assign(s.editor, JSON.stringify({ assigneeId: "" }));
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toBe("Validation failed");
    expect(await assign(s.editor, MALFORMED)).toEqual({ status: 400, body: JSON.stringify({ error: "Body must be valid JSON" }) });
    const version = (await s.editor.c.get(`/api/tasks/${s.t1}`)).json.task.updatedAt as string;
    const ok = await assign(s.editor, JSON.stringify({ assigneeId: s.editor.id, expectedUpdatedAt: version }));
    expect(ok, ok.body).toEqual({ status: 200, body: JSON.stringify({ status: "ok" }) });
    expect((await s.editor.c.get(`/api/tasks/${s.t1}`)).json.task.assignee.id).toBe(s.editor.id);
    // A member still gets Task not found for a task in Trash, the same as a missing id.
    expect((await s.editor.c.get(`/api/tasks/${s.t2}`)).json).toEqual({ error: "Task not found" });
  });

  it("qa:TC missing AC3: no session gets 401 Not signed in for a live task, a deleted task and a missing id on every task route", async () => {
    const s = await setup();
    const anon = new Client();
    for (const r of ROUTES) {
      for (const body of bodies(r, s)) {
        for (const id of [s.t1, s.t2, MISSING]) {
          const res = await send(anon.cookie, r.method, r.path(id), body);
          expect(res, `${r.method} ${r.path(id)} ${body ?? ""}`).toEqual({ status: 401, body: JSON.stringify({ error: "Not signed in" }) });
        }
      }
    }
  });
});
