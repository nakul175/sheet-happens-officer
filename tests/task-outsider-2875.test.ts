// APL-2875 (ACs v1.3): a caller who cannot see a task gets exactly the answer for a missing id, on every task route
// (R1-R14 through loadTask, R4 assign, R15-R16 links, R17 convert) and on Undo and bulk-undo (R18).
// Test data: ZZ-TEST names and nakul17+ aliases. Projects are archived and people deactivated through the API afterwards.
import { afterAll, describe, expect, it } from "vitest";
import { account, BASE, Client, istDate, superAdmin, type Account } from "./helpers";
import { db } from "../src/lib/db";
import { getTask, recordAccess, taskAccess } from "../src/lib/tasks";

type Res = { status: number; body: string };

const RUN = Date.now().toString(36);
const MISSING = `zz-test-missing-${RUN}`;
const MALFORMED = "{";
const people: Account[] = [];
const projects: { id: string; lead: Account }[] = [];
let seeds = 0;

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

type Route = { r: string; method: string; path: (id: string, s: Seed) => string; valid: (s: Seed) => object | undefined; invalid?: object };
type Seed = Awaited<ReturnType<typeof setup>>;

const VERSION = "2020-01-01T00:00:00.000Z";
// R1-R17 of the APL-2875 v1.3 ACs: every route under /api/tasks/:id.
const ROUTES: Route[] = [
  { r: "R1", method: "GET", path: (id) => `/api/tasks/${id}`, valid: () => undefined },
  { r: "R2", method: "PATCH", path: (id) => `/api/tasks/${id}`, valid: () => ({ title: "ZZ-TEST changed", expectedUpdatedAt: VERSION }), invalid: { title: 7 } },
  { r: "R3", method: "DELETE", path: (id) => `/api/tasks/${id}`, valid: () => undefined },
  { r: "R4", method: "POST", path: (id) => `/api/tasks/${id}/assign`, valid: (s) => ({ assigneeId: s.editor.id, expectedUpdatedAt: VERSION }), invalid: { assigneeId: "" } },
  { r: "R5", method: "POST", path: (id) => `/api/tasks/${id}/collaborators`, valid: (s) => ({ userId: s.editor.id }), invalid: { userId: "" } },
  { r: "R6", method: "DELETE", path: (id, s) => `/api/tasks/${id}/collaborators/${s.editor.id}`, valid: () => undefined },
  { r: "R7", method: "PUT", path: (id) => `/api/tasks/${id}/approver`, valid: (s) => ({ approverId: s.editor.id, expectedUpdatedAt: VERSION }), invalid: { approverId: "" } },
  { r: "R8", method: "POST", path: (id) => `/api/tasks/${id}/send-for-approval`, valid: () => ({}) },
  { r: "R9", method: "POST", path: (id) => `/api/tasks/${id}/send-back`, valid: () => ({}) },
  { r: "R10", method: "POST", path: (id) => `/api/tasks/${id}/complete`, valid: () => ({ expectedUpdatedAt: VERSION }), invalid: { completeAll: "yes" } },
  { r: "R11", method: "POST", path: (id) => `/api/tasks/${id}/reopen`, valid: () => ({}), invalid: { sectionId: "" } },
  { r: "R12", method: "POST", path: (id) => `/api/tasks/${id}/move`, valid: (s) => ({ sectionId: s.doing, expectedUpdatedAt: VERSION }), invalid: { sectionId: "" } },
  { r: "R13", method: "POST", path: (id) => `/api/tasks/${id}/restore`, valid: () => ({}), invalid: { confirmParent: "yes" } },
  { r: "R14", method: "POST", path: (id) => `/api/tasks/${id}/idea`, valid: () => ({ isIdea: true }), invalid: { isIdea: "yes" } },
  { r: "R15", method: "POST", path: (id) => `/api/tasks/${id}/links`, valid: (s) => ({ organisationId: s.orgId }), invalid: { organisationId: 7 } },
  { r: "R16", method: "DELETE", path: (id, s) => `/api/tasks/${id}/links/${s.linkId}`, valid: () => undefined },
  { r: "R17", method: "POST", path: (id) => `/api/tasks/${id}/convert`, valid: () => ({}), invalid: { force: "yes" } },
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
  const org = await lead.c.post("/api/orgs", { name: `ZZ-TEST APL-2875 org ${RUN} ${++seeds}` });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  const orgId = org.json.organisation.id as string;
  const link = await lead.c.post(`/api/tasks/${t1}/links`, { organisationId: orgId });
  expect(link.status, JSON.stringify(link.json)).toBe(201);
  expect((await lead.c.del(`/api/tasks/${t2}`)).status).toBe(204);
  const left = await lead.c.del(`/api/projects/${pid}/members/${removed.id}`);
  expect(left.status, JSON.stringify(left.json)).toBeLessThan(300);
  // An undoable action-log row in P1 for R18.
  const logRow = await db.actionLog.findFirst({ where: { projectId: pid, targetId: t2, action: "task.deleted" } });
  expect(logRow?.id).toBeTruthy();
  return { lead, editor, viewer, outsider, removed, pid, t1, t2, doing: sections[1].id, orgId, linkId: link.json.link.id as string, logId: logRow!.id };
}

/** Stored state of the tasks, so a refused call can be shown to change nothing. */
async function snapshot(ids: string[]) {
  const rows = await db.task.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
  return {
    rows: rows.map((t) => ({ id: t.id, updatedAt: t.updatedAt.toISOString(), assigneeId: t.assigneeId, deletedAt: t.deletedAt?.toISOString() ?? null, isIdea: t.isIdea })),
    actions: await db.actionLog.count({ where: { targetId: { in: ids } } }),
    links: await db.taskLink.count({ where: { taskId: { in: ids } } }),
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
          const missing = await send(who.c.cookie, r.method, r.path(MISSING, s), body);
          const live = await send(who.c.cookie, r.method, r.path(s.t1, s), body);
          expect(live, `${r.r} ${who.name} ${r.method} ${r.path("T1", s)} ${body ?? ""}`).toEqual(missing);
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
        const missing = await send(s.outsider.c.cookie, r.method, r.path(MISSING, s), body);
        const deleted = await send(s.outsider.c.cookie, r.method, r.path(s.t2, s), body);
        expect(deleted, `${r.r} ${r.method} ${r.path("T2", s)} ${body ?? ""}`).toEqual(missing);
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
      // R1-R14 go through loadTask; links and convert call taskAccess directly; both end in recordAccess.
      // tests/task-outsider-2875-crm.test.ts sends R1-R17 for this example over HTTP to a CRM_VISIBLE=admins server.
      await expect(taskAccess(member, dealId, { write: true })).rejects.toMatchObject({ status: 404, message: "Task not found" });
    } finally {
      if (was === undefined) delete process.env.CRM_VISIBLE; else process.env.CRM_VISIBLE = was;
    }
  });

  it("qa:TC missing AC1: R18 Undo gives an outsider and a removed member the missing-action answer, and nothing is undone", async () => {
    const s = await setup();
    const before = await snapshot([s.t1, s.t2]);
    const missingId = `zz-test-missing-action-${RUN}`;
    for (const who of [s.outsider, s.removed]) {
      for (const body of [undefined, JSON.stringify({ anyway: true }), JSON.stringify({ anyway: "yes" }), MALFORMED]) {
        const missing = await send(who.c.cookie, "POST", `/api/actions/${missingId}/undo`, body);
        const live = await send(who.c.cookie, "POST", `/api/actions/${s.logId}/undo`, body);
        expect(live, `R18 ${who.name} ${body ?? ""}`).toEqual(missing);
        expect(live.body).not.toMatch(/Project not found|ZZ-TEST|nakul17/);
      }
      expect(await send(who.c.cookie, "POST", `/api/actions/${s.logId}/undo`)).toEqual({ status: 404, body: JSON.stringify({ error: "Action not found" }) });
    }
    expect(await snapshot([s.t1, s.t2])).toEqual(before);
    await expect(recordAccess({ id: s.outsider.id, orgRole: "MEMBER" }, s.pid, "Action")).rejects.toMatchObject({ status: 404, message: "Action not found" });
  });

  it("qa:TC missing AC1: R18 bulk-undo gives an outsider and a removed member the missing-id answer, and nothing is undone", async () => {
    const s = await setup();
    const before = await snapshot([s.t1, s.t2]);
    const missingId = `zz-test-missing-action-${RUN}`;
    const bulk = (who: Account, body: string) => send(who.c.cookie, "POST", "/api/actions/bulk-undo", body);
    for (const who of [s.outsider, s.removed]) {
      for (const anyway of [undefined, true]) {
        const missing = await bulk(who, JSON.stringify({ ids: [missingId], anyway }));
        expect(missing).toEqual({ status: 409, body: JSON.stringify({ error: "This was already undone." }) });
        expect(await bulk(who, JSON.stringify({ ids: [s.logId], anyway })), `${who.name} anyway=${anyway}`).toEqual(missing);
        expect(await bulk(who, JSON.stringify({ ids: [s.logId, missingId], anyway })), `${who.name} mixed anyway=${anyway}`).toEqual(missing);
      }
    }
    expect(await snapshot([s.t1, s.t2])).toEqual(before);
    // The Leader's bulk Undo of the same row still works, and the missing id beside it is skipped as before.
    const lead = await bulk(s.lead, JSON.stringify({ ids: [s.logId, missingId] }));
    expect(lead.status, lead.body).toBe(200);
    expect(JSON.parse(lead.body)).toMatchObject({ count: 1 });
  });

  it("qa:TC missing AC1: a hidden id gets the same body as a missing id, the flat body main gives", async () => {
    const s = await setup();
    // The routes that take a version: main answers a missing task id with this flat body, and so does a hidden one.
    for (const [method, path, body] of [
      ["PATCH", (id: string) => `/api/tasks/${id}`, { title: "ZZ-TEST", expectedUpdatedAt: VERSION }],
      ["POST", (id: string) => `/api/tasks/${id}/assign`, { assigneeId: s.editor.id, expectedUpdatedAt: VERSION }],
      ["PUT", (id: string) => `/api/tasks/${id}/approver`, { approverId: null, expectedUpdatedAt: VERSION }],
      ["POST", (id: string) => `/api/tasks/${id}/complete`, { expectedUpdatedAt: VERSION }],
      ["POST", (id: string) => `/api/tasks/${id}/move`, { sectionId: s.doing, expectedUpdatedAt: VERSION }],
    ] as const) {
      for (const [who, id] of [[s.lead, MISSING], [s.outsider, s.t1]] as const) {
        expect(await send(who.c.cookie, method, path(id), JSON.stringify(body)), `${method} ${path("X")}`).toEqual({ status: 404, body: JSON.stringify({ error: "Task not found" }) });
      }
    }
    // Every other fixed route keeps its flat body too.
    for (const [who, id] of [[s.lead, MISSING], [s.outsider, s.t1]] as const) {
      expect(await send(who.c.cookie, "GET", `/api/tasks/${id}`)).toEqual({ status: 404, body: JSON.stringify({ error: "Task not found" }) });
      expect(await send(who.c.cookie, "POST", `/api/tasks/${id}/links`, JSON.stringify({ organisationId: s.orgId }))).toEqual({ status: 404, body: JSON.stringify({ error: "Task not found" }) });
    }
    for (const [who, id] of [[s.lead, `zz-test-missing-action-${RUN}`], [s.outsider, s.logId]] as const) {
      expect(await send(who.c.cookie, "POST", `/api/actions/${id}/undo`)).toEqual({ status: 404, body: JSON.stringify({ error: "Action not found" }) });
    }
  });

  it("qa:TC missing AC3: members keep today's answers", async () => {
    const s = await setup();
    const assign = (who: Account, body: string) => send(who.c.cookie, "POST", `/api/tasks/${s.t1}/assign`, body);
    // A member still gets Task not found for a task in Trash, the same as a missing id.
    expect((await s.editor.c.get(`/api/tasks/${s.t2}`)).json).toEqual({ error: "Task not found" });
    expect(await assign(s.viewer, JSON.stringify({ assigneeId: s.editor.id, expectedUpdatedAt: VERSION })))
      .toEqual({ status: 403, body: JSON.stringify({ error: "Viewers cannot make changes." }) });
    expect((await s.editor.c.get(`/api/tasks/${s.t1}`)).status).toBe(200);
    // APL-2670 AC1 v1.4: version before schema, so a well-formed version lets the schema answer.
    const bad = await assign(s.editor, JSON.stringify({ assigneeId: "", expectedUpdatedAt: VERSION }));
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toBe("Validation failed");
    expect(await assign(s.editor, MALFORMED)).toEqual({ status: 400, body: JSON.stringify({ error: "Body must be valid JSON" }) });
    const version = (await s.editor.c.get(`/api/tasks/${s.t1}`)).json.task.updatedAt as string;
    const ok = await assign(s.editor, JSON.stringify({ assigneeId: s.editor.id, expectedUpdatedAt: version }));
    expect(ok, ok.body).toEqual({ status: 200, body: JSON.stringify({ status: "ok" }) });
    expect((await s.editor.c.get(`/api/tasks/${s.t1}`)).json.task.assignee.id).toBe(s.editor.id);
    // APL-2714: access is still checked before the body on assign, so a Viewer's bad body is 403, not 400.
    expect(await assign(s.viewer, JSON.stringify({ assigneeId: "" }))).toEqual({ status: 403, body: JSON.stringify({ error: "Viewers cannot make changes." }) });
    expect(await assign(s.viewer, MALFORMED)).toEqual({ status: 403, body: JSON.stringify({ error: "Viewers cannot make changes." }) });
    // R16: a missing link id is still Link not found for a member.
    expect(await send(s.editor.c.cookie, "DELETE", `/api/tasks/${s.t1}/links/zz-test-missing-link`)).toEqual({ status: 404, body: JSON.stringify({ error: "Link not found" }) });
    // R15 and R17: a Viewer still gets the write refusal.
    expect(await send(s.viewer.c.cookie, "POST", `/api/tasks/${s.t1}/links`, JSON.stringify({ organisationId: s.orgId })))
      .toEqual({ status: 403, body: JSON.stringify({ error: "Viewers cannot make changes." }) });
    expect((await send(s.viewer.c.cookie, "POST", `/api/tasks/${s.t1}/convert`, "{}")).status).toBe(403);
    // R18: an Editor who did not make the change still gets today's refusal, and the Leader can undo the delete.
    expect(await send(s.editor.c.cookie, "POST", `/api/actions/${s.logId}/undo`)).toEqual({ status: 403, body: JSON.stringify({ error: "You can only undo your own actions." }) });
    expect((await send(s.lead.c.cookie, "POST", `/api/actions/${s.logId}/undo`)).status).toBe(200);

  });

  it("qa:TC missing AC2: no session gets 401 Not signed in for a live task, a deleted task and a missing id on every task route and on Undo", async () => {
    const s = await setup();
    const anon = new Client();
    for (const r of ROUTES) {
      for (const body of bodies(r, s)) {
        for (const id of [s.t1, s.t2, MISSING]) {
          const res = await send(anon.cookie, r.method, r.path(id, s), body);
          expect(res, `${r.r} ${r.method} ${r.path(id, s)} ${body ?? ""}`).toEqual({ status: 401, body: JSON.stringify({ error: "Not signed in" }) });
        }
      }
    }
    for (const id of [s.logId, `zz-test-missing-action-${RUN}`]) {
      expect(await send(anon.cookie, "POST", `/api/actions/${id}/undo`)).toEqual({ status: 401, body: JSON.stringify({ error: "Not signed in" }) });
    }
  });
});
