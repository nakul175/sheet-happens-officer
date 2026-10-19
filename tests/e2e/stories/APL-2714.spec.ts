// APL-2714 story spec: projects/[id], tasks/[id]/assign and team/[id]/deactivate answer auth and access before the body.
// Drives the running app over HTTP with Playwright's APIRequestContext (playwright-core; no browser is needed).
// Production hosts are refused. Point TASKBOARD_URL at a local server, never at production.
// Thrown-away people and projects use ZZ-TEST names and nakul17+ aliases; afterAll archives the projects
// and deactivates the people.
import { afterAll, describe, expect, it } from "vitest";
import { request, type APIRequestContext } from "playwright-core";
import { assertStoryTargetAllowed } from "../base-url";
import { BASE, PW, account, superAdmin, type Account } from "../../helpers";

// The target is TASKBOARD_URL (BASE); pass it so the guard checks exactly that.
assertStoryTargetAllowed(process.env, BASE);

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;
const people: Account[] = [];
const projectIds: string[] = [];
const contexts: APIRequestContext[] = [];

type Answer = { status: number; body: Record<string, unknown> | null };
type Who = { api: APIRequestContext; id: string };

async function zzAccount(role: string, promote?: Account): Promise<Account> {
  const slug = role.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const email = `nakul17+zz-2714-${RUN}-${slug}-${seq++}@aplyd.com`;
  const who = await account(`ZZ-TEST ${role} ${RUN}`, email);
  people.push(who);
  if (promote) expect((await promote.c.patch(`/api/team/${who.id}`, { orgRole: "ADMIN" })).status).toBe(200);
  return who;
}

/** A Playwright request context signed in as `who`. */
async function signedIn(who: Account): Promise<Who> {
  const api = await request.newContext({ baseURL: BASE });
  contexts.push(api);
  const r = await api.post("/api/auth/signin", { data: { email: who.email, password: PW } });
  expect(r.status()).toBe(200);
  return { api, id: who.id };
}

async function anon(): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL: BASE });
  contexts.push(api);
  return api;
}

/** `body` "{" goes out verbatim as malformed JSON; anything else is serialised. */
async function send(api: APIRequestContext, method: "PATCH" | "POST", path: string, body: object | "{"): Promise<Answer> {
  const res = await api.fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    // Bytes, not a string: Playwright JSON-encodes a string `data` when the content type is JSON.
    data: Buffer.from(body === "{" ? "{" : JSON.stringify(body)),
  });
  const text = await res.text();
  return { status: res.status(), body: text ? JSON.parse(text) : null };
}

function refused(a: Answer, status: number, error: string) {
  expect(a.status, JSON.stringify(a.body)).toBe(status);
  expect(a.body).toEqual({ error });
  expect(JSON.stringify(a.body)).not.toMatch(/Validation failed|"issues"|Body must be valid JSON/);
}

const TASK_NOT_FOUND = { error: { code: "not_found", message: "Task not found" } };

let world: Promise<{
  sa: Who; lead: Who; editor: Who; viewer: Who; outsider: Who; member: Who; orgAdmin: Who;
  other: Account; admin2: Account; projectId: string; taskId: string;
}> | null = null;

/** One ZZ-TEST project P1 with a task T1, a Leader, an Editor and a Viewer; plus an outsider, a Member and two org Admins. */
function setup() {
  world ??= (async () => {
    const saAcc = await superAdmin();
    const leadAcc = await zzAccount("Leader");
    const edAcc = await zzAccount("Editor");
    const viewAcc = await zzAccount("Viewer");
    const outAcc = await zzAccount("Outsider");
    const memberAcc = await zzAccount("Member");
    const other = await zzAccount("Other");
    const adminAcc = await zzAccount("Admin", saAcc);
    const admin2 = await zzAccount("AdminTwo", saAcc);

    const created = await leadAcc.c.post("/api/projects", { name: `ZZ-TEST ${RUN}-${seq++}`, leaderId: leadAcc.id });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const projectId = created.json.project.id as string;
    projectIds.push(projectId);
    for (const [who, role] of [[edAcc, "EDITOR"], [viewAcc, "VIEWER"]] as const) {
      expect((await leadAcc.c.post(`/api/projects/${projectId}/members`, { userId: who.id, role })).status).toBe(201);
    }
    const t = await leadAcc.c.post(`/api/projects/${projectId}/tasks`, { title: `ZZ-TEST T1 ${RUN}` });
    expect(t.status, JSON.stringify(t.json)).toBe(201);

    return {
      sa: await signedIn(saAcc),
      lead: await signedIn(leadAcc),
      editor: await signedIn(edAcc),
      viewer: await signedIn(viewAcc),
      outsider: await signedIn(outAcc),
      member: await signedIn(memberAcc),
      orgAdmin: await signedIn(adminAcc),
      other,
      admin2,
      projectId,
      taskId: t.json.task.id as string,
    };
  })();
  return world;
}

async function taskNow(api: APIRequestContext, id: string) {
  const r = await api.get(`/api/tasks/${id}`);
  expect(r.status()).toBe(200);
  return (await r.json()).task as { updatedAt: string; assignee: { id: string } };
}

describe("qa:TC missing APL-2714 story: auth and access before the body", () => {
  afterAll(async () => {
    const sa = await superAdmin();
    const problems: string[] = [];
    for (const id of projectIds) {
      // The Super Admin takes over as Leader first, so the ZZ-TEST Leader can be deactivated below.
      const added = await sa.c.post(`/api/projects/${id}/members`, { userId: sa.id, role: "EDITOR" });
      if (added.status !== 201 && !(added.status === 409 && /already a member/.test(added.json?.error ?? ""))) problems.push(`add member ${id}: ${added.status}`);
      const led = await sa.c.post(`/api/projects/${id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" });
      if (led.status !== 200) problems.push(`change leader ${id}: ${led.status}`);
      const archived = await sa.c.post(`/api/projects/${id}/archive`);
      if (archived.status !== 200) problems.push(`archive ${id}: ${archived.status}`);
    }
    for (const who of people) {
      const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
      if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) {
        problems.push(`deactivate ${who.email}: ${off.status}`);
      }
    }
    for (const api of contexts) await api.dispose();
    expect(problems).toEqual([]);
  });

  it("qa:TC missing AC1: no session cookie gets 401 Not signed in for invalid and malformed bodies", async () => {
    const w = await setup();
    const api = await anon();
    for (const [method, path, invalid] of [
      ["PATCH", `/api/projects/${w.projectId}`, { name: "" }],
      ["POST", `/api/tasks/${w.taskId}/assign`, { assigneeId: "" }],
      ["POST", `/api/team/${w.editor.id}/deactivate`, { reassign: "" }],
    ] as const) {
      for (const body of [invalid, "{"] as const) refused(await send(api, method, path, body), 401, "Not signed in");
    }
  });

  it("qa:TC missing AC2: a signed-in caller without access gets the access answer, and nothing changes", async () => {
    const w = await setup();
    const projectBefore = await (await w.lead.api.get(`/api/projects/${w.projectId}`)).json();
    const taskBefore = await taskNow(w.lead.api, w.taskId);
    const rows: [Who, "PATCH" | "POST", string, object, number, string][] = [
      [w.outsider, "PATCH", `/api/projects/${w.projectId}`, { name: "" }, 404, "Project not found"],
      [w.editor, "PATCH", `/api/projects/${w.projectId}`, { name: "" }, 403, "Only the project Leader or an Admin can do this."],
      [w.viewer, "POST", `/api/tasks/${w.taskId}/assign`, { assigneeId: "" }, 403, "Viewers cannot make changes."],
      [w.member, "POST", `/api/team/${w.other.id}/deactivate`, { reassign: "" }, 403, "You cannot deactivate this person."],
      [w.orgAdmin, "POST", `/api/team/${w.admin2.id}/deactivate`, { reassign: "" }, 403, "You cannot deactivate this person."],
    ];
    for (const [who, method, path, invalid, status, error] of rows) {
      for (const body of [invalid, "{"] as const) refused(await send(who.api, method, path, body), status, error);
    }
    for (const body of [{ assigneeId: "" }, "{"] as const) {
      const hidden = await send(w.outsider.api, "POST", `/api/tasks/${w.taskId}/assign`, body);
      expect(hidden).toEqual({ status: 404, body: TASK_NOT_FOUND });
    }
    const projectAfter = await (await w.lead.api.get(`/api/projects/${w.projectId}`)).json();
    expect(projectAfter.project.name).toBe(projectBefore.project.name);
    expect(await taskNow(w.lead.api, w.taskId)).toMatchObject({ updatedAt: taskBefore.updatedAt, assignee: { id: taskBefore.assignee.id } });
    for (const id of [w.other.id, w.admin2.id]) {
      const person = await w.sa.api.get(`/api/team/${id}`);
      expect(person.status()).toBe(200);
      expect((await person.json()).person.status).toBe("ACTIVE");
    }
  });

  it("qa:TC missing AC3: an allowed caller still gets Validation failed and Body must be valid JSON", async () => {
    const w = await setup();
    const version = (await taskNow(w.lead.api, w.taskId)).updatedAt;
    for (const [who, method, path, invalid] of [
      [w.lead, "PATCH", `/api/projects/${w.projectId}`, { name: "" }],
      [w.lead, "POST", `/api/tasks/${w.taskId}/assign`, { assigneeId: "", expectedUpdatedAt: version }],
      [w.sa, "POST", `/api/team/${w.other.id}/deactivate`, { reassign: "" }],
    ] as const) {
      const bad = await send(who.api, method, path, invalid);
      expect(bad.status).toBe(400);
      expect(bad.body?.error).toBe("Validation failed");
      expect(Array.isArray(bad.body?.issues) && (bad.body!.issues as unknown[]).length > 0).toBe(true);
      const malformed = await send(who.api, method, path, "{");
      expect(malformed).toEqual({ status: 400, body: { error: "Body must be valid JSON" } });
    }
  });

  it("qa:TC missing AC4: rename P1, assign T1 to the Editor, deactivate then reactivate a ZZ-TEST person", async () => {
    const w = await setup();
    const name = `ZZ-TEST renamed ${RUN}`;
    expect(await send(w.lead.api, "PATCH", `/api/projects/${w.projectId}`, { name })).toEqual({ status: 200, body: { status: "ok" } });
    expect((await (await w.lead.api.get(`/api/projects/${w.projectId}`)).json()).project.name).toBe(name);

    const version = (await taskNow(w.lead.api, w.taskId)).updatedAt;
    expect(await send(w.lead.api, "POST", `/api/tasks/${w.taskId}/assign`, { assigneeId: w.editor.id, expectedUpdatedAt: version }))
      .toEqual({ status: 200, body: { status: "ok" } });
    expect((await taskNow(w.lead.api, w.taskId)).assignee.id).toBe(w.editor.id);

    expect(await send(w.sa.api, "POST", `/api/team/${w.other.id}/deactivate`, { reassign: "leaders" }))
      .toEqual({ status: 200, body: { moved: 0, fellBack: [] } });
    expect((await (await w.sa.api.get(`/api/team/${w.other.id}`)).json()).person.status).toBe("DEACTIVATED");
    expect(await send(w.sa.api, "POST", `/api/team/${w.other.id}/reactivate`, {})).toEqual({ status: 200, body: { status: "ok" } });
    expect((await (await w.sa.api.get(`/api/team/${w.other.id}`)).json()).person.status).toBe("ACTIVE");
  });
});
