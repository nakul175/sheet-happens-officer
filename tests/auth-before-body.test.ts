// APL-2651: session and access checks run before the body is parsed.
// Thrown-away people and records use ZZ-TEST names and nakul17+ aliases (self-signup only accepts @aplyd.com).
// afterAll removes the view and contact, archives the organisation and project, clears the chat, and
// deactivates the people, all through the API.
import { afterAll, describe, expect, it } from "vitest";
import { account, BASE, Client, superAdmin, task, type Account } from "./helpers";

type Res = { status: number; json: { error?: string; issues?: { path: unknown; message: string }[]; [k: string]: unknown } | null };

async function send(method: string, path: string, body: string, cookie = ""): Promise<Res> {
  const res = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body,
  });
  const text = await res.text();
  const json = text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null;
  return { status: res.status, json };
}

const call = (who: Client, method: string, path: string, body: unknown) =>
  who.call(method, path, body) as Promise<Res>;

function expectSignedOut(r: Res) {
  expect(r.status).toBe(401);
  expect(r.json).toEqual({ error: "Not signed in" });
}

function expectValidation(r: Res) {
  expect(r.status).toBe(400);
  expect(r.json?.error).toBe("Validation failed");
  expect(Object.keys(r.json ?? {}).sort()).toEqual(["error", "issues"]);
  expect(r.json!.issues!.length).toBeGreaterThan(0);
  for (const issue of r.json!.issues!) {
    expect(Object.keys(issue).sort()).toEqual(["message", "path"]);
    expect(Array.isArray(issue.path)).toBe(true);
    expect(typeof issue.message).toBe("string");
  }
}

function expectBadJson(r: Res) {
  expect(r.status).toBe(400);
  expect(r.json).toEqual({ error: "Body must be valid JSON" });
}

function expectAccess(r: Res, status: number, error: string) {
  expect(r.status).toBe(status);
  expect(r.json).toEqual({ error });
  expect(JSON.stringify(r.json)).not.toMatch(/Validation failed|issues/);
}

const viewState = { assignee: "", flags: ["overdue"], priority: "", sort: "date", group: "section" };

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;
const zz = (label: string) => `ZZ-TEST ${label} ${RUN}-${seq++}`;

/** Everything the test creates, so afterAll can remove it through the API. */
const made = { people: [] as Account[], projects: [] as string[], orgs: [] as string[], views: [] as { id: string; owner: Account }[], contacts: [] as string[] };

/** A throwaway person: ZZ-TEST display name, run-unique nakul17+ alias. */
async function zzAccount(role: string) {
  const n = seq++;
  const who = await account(`ZZ-TEST ${role} ${RUN}-${n}`, `nakul17+zz-2651-${RUN}-${role}-${n}@aplyd.com`);
  made.people.push(who);
  return who;
}

async function zzProject(leader: Account, members: { who: Account; role?: "EDITOR" | "VIEWER" }[]) {
  const r = await leader.c.post("/api/projects", { name: zz("auth before body"), leaderId: leader.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  made.projects.push(id);
  for (const m of members) {
    expect((await leader.c.post(`/api/projects/${id}/members`, { userId: m.who.id, role: m.role ?? "EDITOR" })).status).toBe(201);
  }
  const sections = (await leader.c.get(`/api/projects/${id}`)).json.project.sections as { id: string }[];
  return { id, doing: sections[1].id };
}

afterAll(async () => {
  const sa = await superAdmin();
  const problems: string[] = [];
  const check = (what: string, r: { status: number; json: unknown }, ok: number[]) => {
    if (!ok.includes(r.status)) problems.push(`${what}: ${r.status} ${JSON.stringify(r.json)}`);
  };
  // A saved view belongs to its owner; anyone else is told it does not exist.
  for (const v of made.views) check(`delete view ${v.id}`, await v.owner.c.del(`/api/views/${v.id}`), [204, 404]);
  for (const id of made.contacts) check(`remove contact ${id}`, await sa.c.del(`/api/contacts/${id}`), [204, 404]);
  for (const id of made.orgs) check(`archive org ${id}`, await sa.c.post(`/api/orgs/${id}/archive`, { archive: true }), [200, 409]);
  for (const id of made.projects) {
    // Hand the project to the Super Admin, so the throwaway Leader can be deactivated below.
    const added = await sa.c.post(`/api/projects/${id}/members`, { userId: sa.id, role: "EDITOR" });
    if (added.status !== 201 && !(added.status === 409 && /already a member/.test(added.json?.error ?? ""))) problems.push(`add member ${id}: ${added.status} ${JSON.stringify(added.json)}`);
    const led = await sa.c.post(`/api/projects/${id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" });
    if (led.status !== 200 && !(led.status === 400 && /already the Leader/.test(led.json?.error ?? ""))) problems.push(`change leader ${id}: ${led.status} ${JSON.stringify(led.json)}`);
    check(`archive project ${id}`, await sa.c.post(`/api/projects/${id}/archive`), [200, 409]);
  }
  for (const who of made.people) {
    const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
    if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) problems.push(`deactivate ${who.email}: ${off.status} ${JSON.stringify(off.json)}`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
});

describe("qa:TC missing auth before body (APL-2651)", () => {
  const routes = [
    ["POST", "/api/actions/bulk-undo", { ids: [] }, "{"],
    ["PATCH", "/api/tasks/missing-task", { title: "" }, "{"],
    ["PATCH", "/api/team/missing-person", { orgRole: "SUPER_ADMIN" }, "{"],
    ["PATCH", "/api/views/missing-view", { name: "" }, "{"],
    ["PATCH", "/api/contacts/missing-contact", { email: "not-an-email" }, "{"],
    ["PATCH", "/api/projects/missing-project/sections/missing-section", { move: "up" }, "{"],
    ["PATCH", "/api/projects/missing-project/members/missing-user", { role: "LEADER" }, "{"],
  ] as const;

  it("AC1: no session returns 401 and no validation details for a bad body (qa:TC-APL2651-507ede86@v1) (qa:TC-APL2651-0874d1b5@v1)", async () => {
    const anon = new Client();
    for (const [method, path, invalid] of routes) {
      expectSignedOut(await call(anon, method, path, invalid));
      expectSignedOut(await send(method, path, "{"));
    }
  });

  it("AC2: no access returns 403 or not-found, not 400; AC3: an allowed user still gets today's 400, and a valid body still works (qa:TC-APL2651-6edd45b6@v1) (qa:TC-APL2651-93d4350b@v1) (qa:TC-APL2651-cb9e6bf3@v1) (qa:TC-APL2651-fb71e2b6@v1) (qa:TC-APL2651-ae74761c@v1) (qa:TC-APL2651-7c84a16b@v1)", async () => {
    const sa = await superAdmin();
    const lead = await zzAccount("lead");
    const editor = await zzAccount("editor");
    const viewer = await zzAccount("viewer");
    const outsider = await zzAccount("outsider");
    const orgAdmin = await zzAccount("orgadmin");
    expect((await sa.c.patch(`/api/team/${orgAdmin.id}`, { orgRole: "ADMIN" })).status).toBe(200);
    const p = await zzProject(lead, [{ who: editor }, { who: viewer, role: "VIEWER" }]);
    const taskId = await task(lead, p.id, { title: zz("task") });
    const view = await lead.c.post(`/api/projects/${p.id}/views`, { name: zz("view").slice(0, 40), state: viewState });
    expect(view.status).toBe(201);
    const viewId = view.json.view.id as string;
    made.views.push({ id: viewId, owner: lead });
    const org = await lead.c.post("/api/orgs", { name: zz("org") });
    expect(org.status).toBe(201);
    made.orgs.push(org.json.organisation.id as string);
    const contact = await lead.c.post(`/api/orgs/${org.json.organisation.id}/contacts`, { name: zz("contact") });
    expect(contact.status).toBe(201);
    const contactId = contact.json.contact.id as string;
    made.contacts.push(contactId);

    const memberPath = `/api/projects/${p.id}/members/${editor.id}`;
    const sectionPath = `/api/projects/${p.id}/sections/${p.doing}`;
    const taskPath = `/api/tasks/${taskId}`;
    const teamPath = `/api/team/${editor.id}`;
    const viewPath = `/api/views/${viewId}`;
    const contactPath = `/api/contacts/${contactId}`;

    const hit = (who: { c: Client }, method: string, path: string, body: object | "{") =>
      body === "{" ? send(method, path, "{", who.c.cookie) : call(who.c, method, path, body);

    // AC2. Resource id is in the URL, so access is decided before the body is read.
    for (const body of [{ role: "LEADER" }, "{"] as const) {
      expectAccess(await hit(outsider, "PATCH", memberPath, body), 404, "Project not found");
      expectAccess(await hit(editor, "PATCH", memberPath, body), 403, "Only the project Leader or an Admin can do this.");
    }
    for (const body of [{ move: "up" }, "{"] as const) {
      expectAccess(await hit(outsider, "PATCH", sectionPath, body), 404, "Project not found");
      expectAccess(await hit(editor, "PATCH", sectionPath, body), 403, "Only the project Leader or an Admin can do this.");
    }
    for (const body of [{ title: "" }, "{"] as const) {
      // F8 (Dwight), APL-2651 AC2 v1.2 and APL-2875: an outsider's PATCH gets the same 404 { error: "Task not found" }
      // as a missing id, before the body is read, so the two bodies are byte-identical.
      const hidden = await hit(outsider, "PATCH", taskPath, body);
      expectAccess(hidden, 404, "Task not found");
      const rawText = async (path: string) => (await fetch(BASE + path, {
        method: "PATCH", headers: { "content-type": "application/json", cookie: outsider.c.cookie },
        body: typeof body === "string" ? body : JSON.stringify(body),
      })).text();
      expect(await rawText(taskPath)).toBe(await rawText("/api/tasks/does-not-exist"));
      expectAccess(await hit(viewer, "PATCH", taskPath, body), 403, "Viewers cannot make changes.");
    }
    for (const body of [{ name: "" }, "{"] as const) {
      expectAccess(await hit(editor, "PATCH", viewPath, body), 404, "View not found");
    }
    for (const body of [{ email: "not-an-email" }, "{"] as const) {
      expectAccess(await hit(editor, "PATCH", contactPath, body), 403, "Only the person who added this contact, or an Admin, can change it.");
    }
    for (const body of [{ orgRole: "SUPER_ADMIN" }, "{"] as const) {
      expectAccess(await hit(editor, "PATCH", teamPath, body), 403, "Only the Super Admin can change roles.");
      expectAccess(await hit(orgAdmin, "PATCH", teamPath, body), 403, "Only the Super Admin can change roles.");
    }

    // AC3. The same people, once they are allowed, still see today's validation errors.
    const seen = (await lead.c.get(taskPath)).json.task.updatedAt as string;
    const badTitle = await hit(lead, "PATCH", taskPath, { title: "", expectedUpdatedAt: seen });
    expectValidation(badTitle);
    expect(badTitle.json!.issues).toEqual([{ path: ["title"], message: "Give the task a title." }]);
    expectBadJson(await send("PATCH", taskPath, "{", lead.c.cookie));

    expectValidation(await hit(lead, "PATCH", sectionPath, { move: "up" }));
    expectBadJson(await hit(lead, "PATCH", sectionPath, "{"));

    expectValidation(await hit(lead, "PATCH", memberPath, { role: "LEADER" }));
    expectBadJson(await hit(lead, "PATCH", memberPath, "{"));

    const badName = await hit(lead, "PATCH", viewPath, { name: "" });
    expectValidation(badName);
    expect(badName.json!.issues).toEqual([{ path: ["name"], message: "Give the view a name." }]);
    expectBadJson(await hit(lead, "PATCH", viewPath, "{"));

    expectValidation(await hit(lead, "PATCH", contactPath, { email: "not-an-email" }));
    expectBadJson(await hit(lead, "PATCH", contactPath, "{"));

    expectValidation(await hit(sa, "PATCH", teamPath, { orgRole: "SUPER_ADMIN" }));
    expectBadJson(await hit(sa, "PATCH", teamPath, "{"));

    expectValidation(await hit(lead, "POST", "/api/actions/bulk-undo", { ids: [] }));
    expectBadJson(await hit(lead, "POST", "/api/actions/bulk-undo", "{"));
    expectValidation(await hit(editor, "POST", "/api/actions/bulk-undo", { ids: [] }));


    // A valid body still does what it did before.
    const stillHere = zz("still here");
    const renamed = await hit(lead, "PATCH", taskPath, { title: stillHere, expectedUpdatedAt: seen });
    expect(renamed.status).toBe(200);
    expect(renamed.json!.task).toMatchObject({ title: stillHere });

    const section = await hit(lead, "PATCH", sectionPath, { name: "Doing" });
    expect(section.status).toBe(200);
    expect(section.json).toEqual({ status: "ok" });

    const kept = zz("kept").slice(0, 40);
    const named = await hit(lead, "PATCH", viewPath, { name: kept });
    expect(named.status).toBe(200);
    expect(named.json!.view).toMatchObject({ name: kept });

    const edited = await hit(lead, "PATCH", contactPath, { role: "CEO" });
    expect(edited.status).toBe(200);
    expect(edited.json).toEqual({ status: "ok" });

    const promoted = await hit(sa, "PATCH", `/api/team/${outsider.id}`, { orgRole: "ADMIN" });
    expect(promoted.status).toBe(200);
    expect(promoted.json).toEqual({ status: "ok" });
    expect((await hit(sa, "PATCH", `/api/team/${outsider.id}`, { orgRole: "MEMBER" })).status).toBe(200);

    const movedAt = (await lead.c.get(taskPath)).json.task.updatedAt as string;
    const bulk = await lead.c.post(`/api/projects/${p.id}/tasks/bulk`, { taskIds: [taskId], action: "move", sectionId: p.doing, versions: { [taskId]: movedAt } });
    expect(bulk.status).toBe(200);
    // The action belongs to the Leader. An Editor's valid body is refused on access, not validation.
    // An invalid body has no action ids, so a signed-in Editor still gets 400 (asserted above).
    expectAccess(await hit(editor, "POST", "/api/actions/bulk-undo", { ids: bulk.json.undoIds }), 403, "You can only undo your own actions.");
    const undone = await hit(lead, "POST", "/api/actions/bulk-undo", { ids: bulk.json.undoIds });
    expect(undone.status).toBe(200);
    expect(undone.json).toMatchObject({ count: 1 });

    const role = await hit(lead, "PATCH", memberPath, { role: "VIEWER" });
    expect(role.status).toBe(200);
    expect(role.json).toEqual({ status: "ok" });

  });
});
