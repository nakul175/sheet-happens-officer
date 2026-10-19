// APL-2651 (PR #29): session and resource access run before the body is parsed.
// Eight routes: actions/bulk-undo, concierge/messages, tasks/[id], team/[id], views/[id],
// contacts/[id], projects/[id]/sections/[sectionId], projects/[id]/members/[userId].
//
// Accounts are nakul17+ aliases created for this run (the Super Admin is SHO_ADMIN_*). Every record uses the ZZ-TEST prefix.
// Projects and organisations are archived, and the people this run created are deactivated. Password comes from SHO_QA_PASS.
// Point BASE_URL at the app under test (local next dev). Production hosts are refused by tests/e2e/base-url.ts.
import { writeFileSync } from "node:fs";
import { test, expect, type APIRequestContext, type Browser, type BrowserContext } from "@playwright/test";
import { BASE_URL, login, zz } from "../support";
import { alias, passwordOk, signUp, waitForSinkMail } from "./qa";

const PASS = process.env.SHO_QA_PASS;

type Body = string | Record<string, unknown>;
type Res = { status: number; json: Record<string, unknown> | null; text: string };
type Who = { ctx: BrowserContext; request: APIRequestContext; user: { id: string; orgRole: string; email: string } };

const MALFORMED = "{";
const viewState = { assignee: "", flags: ["overdue"], priority: "", sort: "date", group: "section" };

async function send(req: APIRequestContext, method: string, path: string, body?: Body): Promise<Res> {
  // A string is sent raw. Playwright's `data` option JSON-encodes strings when the content type is JSON,
  // which would turn "{" into a valid JSON string and hide the malformed-body check.
  const storage = "storageState" in req ? await req.storageState() : { cookies: [] as { name: string; value: string }[] };
  const cookie = storage.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const r = await fetch(new URL(path, BASE_URL), {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json: Record<string, unknown> | null = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text };
}

function noValidation(r: Res) {
  const blob = JSON.stringify(r.json ?? r.text);
  expect(blob).not.toContain("Validation failed");
  expect(blob).not.toContain("issues");
}

function expectSignedOut(r: Res) {
  expect(r.status).toBe(401);
  expect(r.json).toEqual({ error: "Not signed in" });
  noValidation(r);
}

function expectAccess(r: Res, status: number, error: string) {
  expect(r.status).toBe(status);
  expect(r.json).toEqual({ error });
  expect(r.status).not.toBe(400);
  noValidation(r);
}

function expectBadJson(r: Res) {
  expect(r.status).toBe(400);
  expect(r.json).toEqual({ error: "Body must be valid JSON" });
}

function expectValidation(r: Res) {
  expect(r.status).toBe(400);
  expect(r.json?.error).toBe("Validation failed");
  expect(Object.keys(r.json ?? {}).sort()).toEqual(["error", "issues"]);
  const issues = r.json?.issues as { path: unknown; message: string }[];
  expect(issues.length).toBeGreaterThan(0);
  for (const issue of issues) {
    expect(Object.keys(issue).sort()).toEqual(["message", "path"]);
    expect(Array.isArray(issue.path)).toBe(true);
    expect(typeof issue.message).toBe("string");
  }
}

async function signIn(browser: Browser, email: string, password = PASS ?? ""): Promise<Who> {
  if (!password) throw new Error("Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  const ctx = await browser.newContext({ baseURL: BASE_URL });
  const r = await ctx.request.post("/api/auth/signin", { data: { email, password } });
  expect(r.status(), `sign in ${email}`).toBe(200);
  const user = (await r.json()).user as Who["user"];
  return { ctx, request: ctx.request, user };
}

const createdIds: string[] = [];

async function register(browser: Browser, tag: string): Promise<Who> {
  const email = alias("2651", tag, "aplyd.com");
  const signed = await signUp(anon, zz(`2651 ${tag}`), email);
  expect(signed.status, signed.body).toBe(201);
  const token = (await waitForSinkMail(email, "Verify")).token;
  expect((await anon.post("/api/auth/verify", { data: { token } })).ok()).toBe(true);
  const who = await signIn(browser, email);
  createdIds.push(who.user.id);
  return who;
}

async function taskVersion() {
  const loaded = await send(lead.request, "GET", `/api/tasks/${taskId}`);
  const version = (loaded.json?.task as { updatedAt?: string } | undefined)?.updatedAt;
  return typeof version === "string" ? version : "";
}

let anon: APIRequestContext;
let sa: Who;
let lead: Who;
let editor: Who;
let viewer: Who;
let outsider: Who;
let orgAdmin: Who;
let projectId: string;
let doing: string;
let taskId: string;
let viewId: string;
let contactId: string;
let orgId: string;
const shapes: Record<string, unknown> = {};

test.beforeAll(async ({ browser, playwright }) => {
  test.setTimeout(240_000);
  // Missing SHO_QA_PASS skips this file instead of failing collection.
  test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  test.skip(!passwordOk(PASS ?? ""), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
  const admin = login("ADMIN"); // no Super Admin login is a failure, not a skip: only SHO_QA_PASS gates the run
  anon = await playwright.request.newContext({ baseURL: BASE_URL });
  const page = await browser.newPage();
  const health = await page.goto("/api/health");
  expect(health?.status()).toBe(200);
  await page.close();

  sa = await signIn(browser, admin.email, admin.password);
  lead = await register(browser, "lead");
  editor = await register(browser, "editor");
  viewer = await register(browser, "viewer");
  outsider = await register(browser, "outsider");
  orgAdmin = await register(browser, "orgadmin");
  const promoted = await send(sa.request, "PATCH", `/api/team/${orgAdmin.user.id}`, { orgRole: "ADMIN" });
  expect(promoted.status, promoted.text).toBe(200);
  orgAdmin.user.orgRole = "ADMIN";
  expect(sa.user.orgRole).toBe("SUPER_ADMIN");
  expect(lead.user.orgRole).toBe("MEMBER");
  expect(orgAdmin.user.orgRole).toBe("ADMIN");

  const name = zz("apl-2651 project");
  const created = await send(lead.request, "POST", "/api/projects", {
    name,
    leaderId: lead.user.id,
    members: [
      { userId: editor.user.id, role: "EDITOR" },
      { userId: viewer.user.id, role: "VIEWER" },
    ],
  });
  expect(created.status, created.text).toBe(201);
  projectId = (created.json?.project as { id: string }).id;
  const loaded = await send(lead.request, "GET", `/api/projects/${projectId}`);
  expect(loaded.status, loaded.text).toBe(200);
  const sections = (loaded.json?.project as { sections: { id: string; isDone: boolean }[] }).sections;
  doing = sections[1].id;

  const task = await send(lead.request, "POST", `/api/projects/${projectId}/tasks`, { title: zz("apl-2651 task") });
  expect(task.status, task.text).toBe(201);
  taskId = (task.json?.task as { id: string }).id;

  const view = await send(lead.request, "POST", `/api/projects/${projectId}/views`, { name: zz("view").slice(0, 40), state: viewState });
  expect(view.status, view.text).toBe(201);
  viewId = (view.json?.view as { id: string }).id;

  const org = await send(lead.request, "POST", "/api/orgs", { name: zz("apl-2651 org") });
  expect(org.status, org.text).toBe(201);
  orgId = (org.json?.organisation as { id: string }).id;
  const contact = await send(lead.request, "POST", `/api/orgs/${orgId}/contacts`, { name: zz("apl-2651 contact") });
  expect(contact.status, contact.text).toBe(201);
  contactId = (contact.json?.contact as { id: string }).id;
});

test.afterAll(async () => {
  if (sa) {
    if (projectId) await send(sa.request, "POST", `/api/projects/${projectId}/archive`).catch(() => undefined);
    if (orgId) await send(sa.request, "POST", `/api/orgs/${orgId}/archive`).catch(() => undefined);
    for (const id of createdIds) await send(sa.request, "POST", `/api/team/${id}/deactivate`, { reassign: "leaders" }).catch(() => undefined);
  }
  if (lead) await send(lead.request, "DELETE", "/api/concierge/messages").catch(() => undefined);
  await Promise.all([sa, lead, editor, viewer, outsider, orgAdmin].filter(Boolean).map((w) => w.ctx.close()));
  await anon?.dispose();
});

// qa:TC TC-APL2651-507ede86@v1 TC-APL2651-0874d1b5@v1
test("AC1 bulk-undo: a signed-out caller gets 401 before the body is parsed qa:TC-APL2651-507ede86@v1 qa:TC-APL2651-0874d1b5@v1", { annotation: [{ type: "qa:TC", description: "TC-APL2651-507ede86@v1" }, { type: "qa:TC", description: "TC-APL2651-0874d1b5@v1" }] }, async () => {
  expectSignedOut(await send(anon, "POST", "/api/actions/bulk-undo", MALFORMED));
  expectSignedOut(await send(anon, "POST", "/api/actions/bulk-undo", { ids: [] }));
});

// qa:TC TC-APL2651-507ede86@v1 TC-APL2651-0874d1b5@v1
test("AC1: no session, malformed or schema-invalid body, returns 401 with no validation details qa:TC-APL2651-507ede86@v1 qa:TC-APL2651-0874d1b5@v1", { annotation: [{ type: "qa:TC", description: "TC-APL2651-507ede86@v1" }, { type: "qa:TC", description: "TC-APL2651-0874d1b5@v1" }] }, async () => {
  const cases: [string, string, Body][] = [
    ["POST", "/api/concierge/messages", MALFORMED],
    ["POST", "/api/concierge/messages", { text: "" }],
    ["PATCH", `/api/tasks/${taskId}`, MALFORMED],
    ["PATCH", `/api/tasks/${taskId}`, { title: "" }],
    ["PATCH", `/api/team/${editor.user.id}`, MALFORMED],
    ["PATCH", `/api/team/${editor.user.id}`, { orgRole: "SUPER_ADMIN" }],
    ["PATCH", `/api/views/${viewId}`, MALFORMED],
    ["PATCH", `/api/views/${viewId}`, { name: "" }],
    ["PATCH", `/api/contacts/${contactId}`, MALFORMED],
    ["PATCH", `/api/contacts/${contactId}`, { email: "not-an-email" }],
    ["PATCH", `/api/projects/${projectId}/sections/${doing}`, MALFORMED],
    ["PATCH", `/api/projects/${projectId}/sections/${doing}`, { move: "up" }],
    ["PATCH", `/api/projects/${projectId}/members/${editor.user.id}`, MALFORMED],
    ["PATCH", `/api/projects/${projectId}/members/${editor.user.id}`, { role: "LEADER" }],
  ];
  const rows = [];
  for (const [method, path, body] of cases) {
    const r = await send(anon, method, path, body);
    rows.push({ method, path: path.replace(projectId, ":project").replace(taskId, ":task").replace(viewId, ":view").replace(contactId, ":contact").replace(doing, ":section").replace(editor.user.id, ":user"), body: typeof body === "string" ? "malformed" : "schema", status: r.status, error: r.json?.error ?? null });
    expectSignedOut(r);
  }
  await test.info().attach("ac1-routes", { body: JSON.stringify(rows, null, 2), contentType: "application/json" });
});

// qa:TC TC-APL2651-6edd45b6@v1 TC-APL2651-93d4350b@v1
test("AC2: signed-in without access gets 403 or the existing not-found answer, not 400 qa:TC-APL2651-6edd45b6@v1 qa:TC-APL2651-93d4350b@v1", { annotation: [{ type: "qa:TC", description: "TC-APL2651-6edd45b6@v1" }, { type: "qa:TC", description: "TC-APL2651-93d4350b@v1" }] }, async () => {
  const memberPath = `/api/projects/${projectId}/members/${editor.user.id}`;
  const sectionPath = `/api/projects/${projectId}/sections/${doing}`;
  const taskPath = `/api/tasks/${taskId}`;
  const teamPath = `/api/team/${editor.user.id}`;
  const viewPath = `/api/views/${viewId}`;
  const contactPath = `/api/contacts/${contactId}`;

  const cases: { route: string; who: Who; method: string; path: string; body: Body; status: number; error: string }[] = [
    { route: "members", who: outsider, method: "PATCH", path: memberPath, body: MALFORMED, status: 404, error: "Project not found" },
    { route: "members", who: outsider, method: "PATCH", path: memberPath, body: { role: "LEADER" }, status: 404, error: "Project not found" },
    { route: "members", who: editor, method: "PATCH", path: memberPath, body: MALFORMED, status: 403, error: "Only the project Leader or an Admin can do this." },
    { route: "members", who: editor, method: "PATCH", path: memberPath, body: { role: "LEADER" }, status: 403, error: "Only the project Leader or an Admin can do this." },
    { route: "sections", who: outsider, method: "PATCH", path: sectionPath, body: MALFORMED, status: 404, error: "Project not found" },
    { route: "sections", who: outsider, method: "PATCH", path: sectionPath, body: { move: "up" }, status: 404, error: "Project not found" },
    { route: "sections", who: editor, method: "PATCH", path: sectionPath, body: MALFORMED, status: 403, error: "Only the project Leader or an Admin can do this." },
    { route: "sections", who: editor, method: "PATCH", path: sectionPath, body: { move: "up" }, status: 403, error: "Only the project Leader or an Admin can do this." },
    { route: "tasks", who: outsider, method: "PATCH", path: taskPath, body: MALFORMED, status: 404, error: "Project not found" },
    { route: "tasks", who: outsider, method: "PATCH", path: taskPath, body: { title: "" }, status: 404, error: "Project not found" },
    { route: "tasks", who: viewer, method: "PATCH", path: taskPath, body: MALFORMED, status: 403, error: "Viewers cannot make changes." },
    { route: "tasks", who: viewer, method: "PATCH", path: taskPath, body: { title: "" }, status: 403, error: "Viewers cannot make changes." },
    { route: "views", who: editor, method: "PATCH", path: viewPath, body: MALFORMED, status: 404, error: "View not found" },
    { route: "views", who: editor, method: "PATCH", path: viewPath, body: { name: "" }, status: 404, error: "View not found" },
    { route: "contacts", who: editor, method: "PATCH", path: contactPath, body: MALFORMED, status: 403, error: "Only the person who added this contact, or an Admin, can change it." },
    { route: "contacts", who: editor, method: "PATCH", path: contactPath, body: { email: "not-an-email" }, status: 403, error: "Only the person who added this contact, or an Admin, can change it." },
    { route: "team", who: editor, method: "PATCH", path: teamPath, body: MALFORMED, status: 403, error: "Only the Super Admin can change roles." },
    { route: "team", who: editor, method: "PATCH", path: teamPath, body: { orgRole: "SUPER_ADMIN" }, status: 403, error: "Only the Super Admin can change roles." },
    { route: "team", who: orgAdmin, method: "PATCH", path: teamPath, body: MALFORMED, status: 403, error: "Only the Super Admin can change roles." },
    { route: "team", who: orgAdmin, method: "PATCH", path: teamPath, body: { orgRole: "SUPER_ADMIN" }, status: 403, error: "Only the Super Admin can change roles." },
  ];

  const rows = [];
  for (const c of cases) {
    const r = await send(c.who.request, c.method, c.path, c.body);
    rows.push({ route: c.route, actor: c.who.user.email.split("+")[1], body: typeof c.body === "string" ? "malformed" : "schema", status: r.status, error: r.json?.error ?? null });
    expectAccess(r, c.status, c.error);
  }
  await test.info().attach("ac2-routes", { body: JSON.stringify(rows, null, 2), contentType: "application/json" });
});

// qa:TC TC-APL2651-6edd45b6@v1 TC-APL2651-93d4350b@v1
test("AC2 bulk-undo: another person's action is 403; a signed-in invalid body stays 400 qa:TC-APL2651-6edd45b6@v1 qa:TC-APL2651-93d4350b@v1", { annotation: [{ type: "qa:TC", description: "TC-APL2651-6edd45b6@v1" }, { type: "qa:TC", description: "TC-APL2651-93d4350b@v1" }] }, async () => {
  // The ids are inside the body, so a signed-in caller with a bad body is 400 on this route (no target to authorise yet).
  expectBadJson(await send(editor.request, "POST", "/api/actions/bulk-undo", MALFORMED));
  expectValidation(await send(editor.request, "POST", "/api/actions/bulk-undo", { ids: [] }));
  expectValidation(await send(outsider.request, "POST", "/api/actions/bulk-undo", { ids: [] }));

  const version = await taskVersion();
  const bulk = await send(lead.request, "POST", `/api/projects/${projectId}/tasks/bulk`, {
    taskIds: [taskId],
    action: "move",
    sectionId: doing,
    ...(version ? { versions: { [taskId]: version } } : {}),
  });
  expect(bulk.status, bulk.text).toBe(200);
  const ids = bulk.json?.undoIds as string[];
  expect(ids?.length).toBeGreaterThan(0);

  const refused = await send(editor.request, "POST", "/api/actions/bulk-undo", { ids });
  expectAccess(refused, 403, "You can only undo your own actions.");

  const undone = await send(lead.request, "POST", "/api/actions/bulk-undo", { ids });
  expect(undone.status, undone.text).toBe(200);
  expect(undone.json).toMatchObject({ count: 1 });
});

// qa:TC TC-APL2651-cb9e6bf3@v1
test("AC3: an authorised caller with a bad body still gets today's 400 shape, and a valid body still works qa:TC-APL2651-cb9e6bf3@v1", { annotation: { type: "qa:TC", description: "TC-APL2651-cb9e6bf3@v1" } }, async () => {
  const memberPath = `/api/projects/${projectId}/members/${editor.user.id}`;
  const sectionPath = `/api/projects/${projectId}/sections/${doing}`;
  const taskPath = `/api/tasks/${taskId}`;
  const teamPath = `/api/team/${outsider.user.id}`;
  const viewPath = `/api/views/${viewId}`;
  const contactPath = `/api/contacts/${contactId}`;

  const seenAt = await taskVersion();
  const badTitle = await send(lead.request, "PATCH", taskPath, { title: "", expectedUpdatedAt: seenAt });
  expectValidation(badTitle);
  expect(badTitle.json?.issues).toEqual([{ path: ["title"], message: "Give the task a title." }]);
  const badTaskJson = await send(lead.request, "PATCH", taskPath, MALFORMED);
  expectBadJson(badTaskJson);

  const badSection = await send(lead.request, "PATCH", sectionPath, { move: "up" });
  expectValidation(badSection);
  expectBadJson(await send(lead.request, "PATCH", sectionPath, MALFORMED));

  const badMember = await send(lead.request, "PATCH", memberPath, { role: "LEADER" });
  expectValidation(badMember);
  expectBadJson(await send(lead.request, "PATCH", memberPath, MALFORMED));

  const badName = await send(lead.request, "PATCH", viewPath, { name: "" });
  expectValidation(badName);
  expect(badName.json?.issues).toEqual([{ path: ["name"], message: "Give the view a name." }]);
  expectBadJson(await send(lead.request, "PATCH", viewPath, MALFORMED));

  const badContact = await send(lead.request, "PATCH", contactPath, { email: "not-an-email" });
  expectValidation(badContact);
  expectBadJson(await send(lead.request, "PATCH", contactPath, MALFORMED));

  const badTeam = await send(sa.request, "PATCH", teamPath, { orgRole: "SUPER_ADMIN" });
  expectValidation(badTeam);
  expectBadJson(await send(sa.request, "PATCH", teamPath, MALFORMED));

  const badUndo = await send(lead.request, "POST", "/api/actions/bulk-undo", { ids: [] });
  expectValidation(badUndo);
  expectBadJson(await send(lead.request, "POST", "/api/actions/bulk-undo", MALFORMED));

  const badChat = await send(lead.request, "POST", "/api/concierge/messages", { text: "" });
  expectValidation(badChat);
  expectBadJson(await send(lead.request, "POST", "/api/concierge/messages", MALFORMED));

  shapes.tasks = badTitle.json;
  shapes.tasksMalformed = badTaskJson.json;
  shapes.sections = badSection.json;
  shapes.members = badMember.json;
  shapes.views = badName.json;
  shapes.contacts = badContact.json;
  shapes.team = badTeam.json;
  shapes.bulkUndo = badUndo.json;
  shapes.concierge = badChat.json;
  if (process.env.SHAPE_OUT) writeFileSync(process.env.SHAPE_OUT, JSON.stringify(shapes, null, 2));
  await test.info().attach("ac3-shapes", { body: JSON.stringify(shapes, null, 2), contentType: "application/json" });

  const version = await taskVersion();
  const renamed = await send(lead.request, "PATCH", taskPath, { title: zz("still here"), ...(version ? { expectedUpdatedAt: version } : {}) });
  expect(renamed.status, renamed.text).toBe(200);
  expect(renamed.json?.task).toMatchObject({ title: expect.stringContaining("ZZ-TEST") });

  const section = await send(lead.request, "PATCH", sectionPath, { name: "Doing" });
  expect(section.status, section.text).toBe(200);
  expect(section.json).toEqual({ status: "ok" });

  const kept = "ZZ-TEST kept";
  const named = await send(lead.request, "PATCH", viewPath, { name: kept });
  expect(named.status, named.text).toBe(200);
  expect(named.json?.view).toMatchObject({ name: kept });

  const edited = await send(lead.request, "PATCH", contactPath, { role: "CEO" });
  expect(edited.status, edited.text).toBe(200);
  expect(edited.json).toEqual({ status: "ok" });

  const promoted = await send(sa.request, "PATCH", teamPath, { orgRole: "ADMIN" });
  expect(promoted.status, promoted.text).toBe(200);
  expect(promoted.json).toEqual({ status: "ok" });
  const demoted = await send(sa.request, "PATCH", teamPath, { orgRole: "MEMBER" });
  expect(demoted.status, demoted.text).toBe(200);

  const role = await send(lead.request, "PATCH", memberPath, { role: "VIEWER" });
  expect(role.status, role.text).toBe(200);
  expect(role.json).toEqual({ status: "ok" });

  const said = await send(lead.request, "POST", "/api/concierge/messages", { text: zz("hello") });
  expect(said.status, said.text).toBe(200);
  expect(said.json?.error).toBeUndefined();
  expect(said.json?.disabled).toMatchObject({ code: "NOT_ENABLED" });
});
