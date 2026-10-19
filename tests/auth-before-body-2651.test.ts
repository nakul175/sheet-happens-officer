// APL-2651 (product part of APL-2703): bulk-undo checks the session, and six PATCH routes check access, before the body.
// Titles carry the published APL-2651 TC ids (register, AC v1.1). AC4 (order in code) has no runtime test here.
// People and records are ZZ-TEST with nakul17+ aliases; afterAll hands leadership back, archives and deactivates
// through the API, and fails if any of that is refused.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { account, BASE, Client, superAdmin, type Account } from "./helpers";

type Res = { status: number; json: { error?: string; issues?: { path: unknown; message: string }[]; [k: string]: unknown } | null };

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const MALFORMED = "{";
const viewState = { assignee: "", flags: ["overdue"], priority: "", sort: "date", group: "section" };

/** Sends the body exactly as given, so "{" reaches the server as malformed JSON. */
async function raw(method: string, path: string, body: string, cookie = ""): Promise<Res> {
  const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body });
  const text = await res.text();
  return { status: res.status, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null };
}
const hit = (c: Client, method: string, path: string, body: object | typeof MALFORMED) =>
  (body === MALFORMED ? raw(method, path, MALFORMED, c.cookie) : c.call(method, path, body)) as Promise<Res>;

function expectAnswer(r: Res, status: number, error: string) {
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  expect(r.json).toEqual({ error });
}
function expectValidation(r: Res) {
  expect(r.status, JSON.stringify(r.json)).toBe(400);
  expect(r.json?.error).toBe("Validation failed");
  expect(r.json?.issues?.length).toBeGreaterThan(0);
}
function expectBadJson(r: Res) {
  expect(r.status).toBe(400);
  expect(r.json).toEqual({ error: "Body must be valid JSON" });
}

const people: Account[] = [];
async function zz(role: string) {
  const who = await account(`ZZ-TEST 2651 ${role} ${RUN}`, `nakul17+zz-2651-${role}-${RUN}@aplyd.com`);
  people.push(who);
  return who;
}

let sa: Account, lead: Account, editor: Account, viewer: Account, outsider: Account, orgAdmin: Account;
let projectId = "", doing = "", taskId = "", viewId = "", orgId = "", contactId = "";
// A second project, led by the Super Admin and archived, for the read-only answer before the body.
let archivedId = "", archivedSection = "", archivedTask = "";
const paths = () => ({
  members: `/api/projects/${projectId}/members/${editor.id}`,
  sections: `/api/projects/${projectId}/sections/${doing}`,
  task: `/api/tasks/${taskId}`,
  team: `/api/team/${editor.id}`,
  view: `/api/views/${viewId}`,
  contact: `/api/contacts/${contactId}`,
});
const INVALID = { members: { role: "LEADER" }, sections: { move: "up" }, task: { title: "" }, team: { orgRole: "SUPER_ADMIN" }, view: { name: "" }, contact: { email: "not-an-email" } } as const;

beforeAll(async () => {
  sa = await superAdmin();
  lead = await zz("lead");
  editor = await zz("editor");
  viewer = await zz("viewer");
  outsider = await zz("outsider");
  orgAdmin = await zz("orgadmin");
  expect((await sa.c.patch(`/api/team/${orgAdmin.id}`, { orgRole: "ADMIN" })).status).toBe(200);

  const created = await lead.c.post("/api/projects", { name: `ZZ-TEST 2651 project ${RUN}`, leaderId: lead.id });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  projectId = created.json.project.id;
  for (const [who, role] of [[editor, "EDITOR"], [viewer, "VIEWER"]] as const) {
    expect((await lead.c.post(`/api/projects/${projectId}/members`, { userId: who.id, role })).status).toBe(201);
  }
  doing = ((await lead.c.get(`/api/projects/${projectId}`)).json.project.sections as { id: string }[])[1].id;
  const t = await lead.c.post(`/api/projects/${projectId}/tasks`, { title: `ZZ-TEST 2651 task ${RUN}` });
  expect(t.status, JSON.stringify(t.json)).toBe(201);
  taskId = t.json.task.id;
  const v = await lead.c.post(`/api/projects/${projectId}/views`, { name: `ZZ-TEST 2651 ${RUN}`.slice(0, 40), state: viewState });
  expect(v.status, JSON.stringify(v.json)).toBe(201);
  viewId = v.json.view.id;
  const o = await lead.c.post("/api/orgs", { name: `ZZ-TEST 2651 org ${RUN}` });
  expect(o.status, JSON.stringify(o.json)).toBe(201);
  orgId = o.json.organisation.id;
  const c = await lead.c.post(`/api/orgs/${orgId}/contacts`, { name: `ZZ-TEST 2651 contact ${RUN}` });
  expect(c.status, JSON.stringify(c.json)).toBe(201);
  contactId = c.json.contact.id;

  const a = await sa.c.post("/api/projects", { name: `ZZ-TEST 2651 archived ${RUN}`, leaderId: sa.id });
  expect(a.status, JSON.stringify(a.json)).toBe(201);
  archivedId = a.json.project.id;
  expect((await sa.c.post(`/api/projects/${archivedId}/members`, { userId: editor.id, role: "EDITOR" })).status).toBe(201);
  archivedSection = ((await sa.c.get(`/api/projects/${archivedId}`)).json.project.sections as { id: string }[])[1].id;
  const at = await sa.c.post(`/api/projects/${archivedId}/tasks`, { title: `ZZ-TEST 2651 archived task ${RUN}` });
  expect(at.status, JSON.stringify(at.json)).toBe(201);
  archivedTask = at.json.task.id;
  expect((await sa.c.post(`/api/projects/${archivedId}/archive`)).status).toBe(200);
}, 120_000);

afterAll(async () => {
  const problems: string[] = [];
  const must = async (what: string, r: Promise<{ status: number; json: unknown }>, ok: (s: number) => boolean) => {
    const res = await r;
    if (!ok(res.status)) problems.push(`${what}: ${res.status} ${JSON.stringify(res.json)}`);
  };
  if (projectId) {
    // The Super Admin takes over as Leader first, so the ZZ-TEST lead can be deactivated afterwards.
    await must("add Super Admin", sa.c.post(`/api/projects/${projectId}/members`, { userId: sa.id, role: "EDITOR" }), (s) => s === 201 || s === 409);
    await must("change leader", sa.c.post(`/api/projects/${projectId}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" }), (s) => s === 200);
    await must("archive project", sa.c.post(`/api/projects/${projectId}/archive`), (s) => s === 200);
  }
  if (orgId) await must("archive org", sa.c.post(`/api/orgs/${orgId}/archive`, { archive: true }), (s) => s === 200);
  for (const who of people.splice(0)) {
    await must(`deactivate ${who.email}`, sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" }), (s) => s === 200);
  }
  expect(problems, "ZZ-TEST clean-up through the API").toEqual([]);
}, 120_000);

describe("qa:TC-APL2651-507ede86@v1 qa:TC-APL2651-0874d1b5@v1 qa:TC-APL2651-6edd45b6@v1 qa:TC-APL2651-93d4350b@v1 qa:TC-APL2651-cb9e6bf3@v1 APL-2651 auth and access before the body (product part)", () => {
  it("qa:TC-APL2651-507ede86@v1 qa:TC-APL2651-0874d1b5@v1 AC1: no session gets 401 Not signed in on all 8 routes, for a malformed or a schema-invalid body", async () => {
    const anon = new Client();
    const p = paths();
    const routes: [string, string, object][] = [
      ["POST", "/api/actions/bulk-undo", { ids: [] }],
      ["POST", "/api/concierge/messages", { text: "" }],
      ["PATCH", p.task, INVALID.task],
      ["PATCH", p.team, INVALID.team],
      ["PATCH", p.view, INVALID.view],
      ["PATCH", p.contact, INVALID.contact],
      ["PATCH", p.sections, INVALID.sections],
      ["PATCH", p.members, INVALID.members],
    ];
    for (const [method, path, invalid] of routes) {
      for (const body of [invalid, MALFORMED] as const) {
        const r = await hit(anon, method, path, body);
        expectAnswer(r, 401, "Not signed in");
        expect(JSON.stringify(r.json), `${method} ${path}`).not.toMatch(/Validation failed|"issues"|Body must be valid JSON/);
      }
    }
  });

  it("qa:TC-APL2651-6edd45b6@v1 qa:TC-APL2651-93d4350b@v1 AC2: a signed-in caller without access gets 403 or not-found on the six PATCH routes, not 400", async () => {
    const p = paths();
    const rows: [Account, keyof typeof INVALID, number, string][] = [
      [outsider, "members", 404, "Project not found"],
      [editor, "members", 403, "Only the project Leader or an Admin can do this."],
      [outsider, "sections", 404, "Project not found"],
      [editor, "sections", 403, "Only the project Leader or an Admin can do this."],
      [outsider, "task", 404, "Project not found"],
      [viewer, "task", 403, "Viewers cannot make changes."],
      [editor, "view", 404, "View not found"],
      [editor, "contact", 403, "Only the person who added this contact, or an Admin, can change it."],
      [editor, "team", 403, "Only the Super Admin can change roles."],
      [orgAdmin, "team", 403, "Only the Super Admin can change roles."],
    ];
    for (const [who, route, status, error] of rows) {
      for (const body of [INVALID[route], MALFORMED] as const) {
        expectAnswer(await hit(who.c, "PATCH", p[route], body), status, error);
      }
    }
  });

  it("qa:TC-APL2651-cb9e6bf3@v1 AC3: an allowed caller with a bad body still gets today's 400 answers", async () => {
    const p = paths();
    for (const route of ["members", "sections", "view", "contact"] as const) {
      expectValidation(await hit(lead.c, "PATCH", p[route], INVALID[route]));
      expectBadJson(await hit(lead.c, "PATCH", p[route], MALFORMED));
    }
    const seen = (await lead.c.get(`/api/tasks/${taskId}`)).json.task.updatedAt as string;
    const badTitle = await hit(lead.c, "PATCH", p.task, { title: "", expectedUpdatedAt: seen });
    expectValidation(badTitle);
    expect(badTitle.json?.issues).toEqual([{ path: ["title"], message: "Give the task a title." }]);
    expectBadJson(await hit(lead.c, "PATCH", p.task, MALFORMED));
    expectValidation(await hit(sa.c, "PATCH", p.team, INVALID.team));
    expectBadJson(await hit(sa.c, "PATCH", p.team, MALFORMED));
    // A signed-in bulk-undo with a bad body is still 400: the ids it would authorise are inside the body.
    expectBadJson(await hit(editor.c, "POST", "/api/actions/bulk-undo", MALFORMED));
    expectValidation(await hit(editor.c, "POST", "/api/actions/bulk-undo", { ids: [] }));
  });

  it("qa:TC-APL2651-cb9e6bf3@v1 AC3: valid bodies still work on the changed routes", async () => {
    const p = paths();
    const seen = (await lead.c.get(`/api/tasks/${taskId}`)).json.task.updatedAt as string;
    const title = `ZZ-TEST 2651 renamed ${RUN}`;
    const t = await lead.c.patch(p.task, { title, expectedUpdatedAt: seen });
    expect(t.status, JSON.stringify(t.json)).toBe(200);
    expect(t.json.task.title).toBe(title);
    const v = await lead.c.patch(p.view, { name: `ZZ-TEST 2651 v2 ${RUN}`.slice(0, 40) });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect((await lead.c.patch(p.contact, { email: `nakul17+zz-2651-contact-${RUN}@aplyd.com` })).status).toBe(200);
    expect((await lead.c.patch(p.members, { role: "VIEWER" })).status).toBe(200);
    expect((await lead.c.patch(p.members, { role: "EDITOR" })).status).toBe(200);
    expect((await lead.c.patch(p.sections, { name: `ZZ-TEST 2651 doing ${RUN}`.slice(0, 40) })).status).toBe(200);
  });

  it("qa:TC-APL2651-6edd45b6@v1 qa:TC-APL2651-93d4350b@v1 AC2: on an archived project the read-only 409 now comes before the body, even for an Admin acting as Leader", async () => {
    // Changed on purpose: the access check (write access to a live project) runs first, so this is 409, not today's 400.
    const rows: [string, object][] = [
      [`/api/projects/${archivedId}/members/${editor.id}`, INVALID.members],
      [`/api/projects/${archivedId}/sections/${archivedSection}`, INVALID.sections],
      [`/api/tasks/${archivedTask}`, INVALID.task],
    ];
    for (const [path, invalid] of rows) {
      for (const body of [invalid, MALFORMED] as const) {
        expectAnswer(await hit(sa.c, "PATCH", path, body), 409, "This project is archived and read-only.");
      }
    }
  });
});
