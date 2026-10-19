// APL-2651: session and access checks run before the body is parsed.
import { describe, expect, it } from "vitest";
import { account, admin, BASE, Client, project, superAdmin, task } from "./helpers";

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

describe("auth before body (APL-2651)", () => {
  const routes = [
    ["POST", "/api/actions/bulk-undo", { ids: [] }, "{"],
    ["POST", "/api/concierge/messages", { text: "" }, "{"],
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

  it("AC2: no access returns 403 or not-found, not 400; AC3: an allowed user still gets today's 400, and a valid body still works (qa:TC-APL2651-6edd45b6@v1) (qa:TC-APL2651-93d4350b@v1) (qa:TC-APL2651-cb9e6bf3@v1) (qa:TC-APL2651-fb71e2b6@v1)", async () => {
    const sa = await superAdmin();
    const lead = await account("lead");
    const editor = await account("ed");
    const viewer = await account("view");
    const outsider = await account("out");
    const orgAdmin = await admin(sa, "orgad");
    const p = await project(lead, lead, [{ who: editor }, { who: viewer, role: "VIEWER" }]);
    const taskId = await task(lead, p.id);
    const view = await lead.c.post(`/api/projects/${p.id}/views`, { name: "Overdue", state: viewState });
    expect(view.status).toBe(201);
    const viewId = view.json.view.id as string;
    const org = await lead.c.post("/api/orgs", { name: `Org ${Date.now()}` });
    expect(org.status).toBe(201);
    const contact = await lead.c.post(`/api/orgs/${org.json.organisation.id}/contacts`, { name: "Asha" });
    expect(contact.status).toBe(201);
    const contactId = contact.json.contact.id as string;

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
      expectAccess(await hit(outsider, "PATCH", taskPath, body), 404, "Project not found");
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

    expectValidation(await hit(lead, "POST", "/api/concierge/messages", { text: "" }));
    expectBadJson(await hit(lead, "POST", "/api/concierge/messages", "{"));

    // A valid body still does what it did before.
    const renamed = await hit(lead, "PATCH", taskPath, { title: "Still here", expectedUpdatedAt: seen });
    expect(renamed.status).toBe(200);
    expect(renamed.json!.task).toMatchObject({ title: "Still here" });

    const section = await hit(lead, "PATCH", sectionPath, { name: "Doing" });
    expect(section.status).toBe(200);
    expect(section.json).toEqual({ status: "ok" });

    const named = await hit(lead, "PATCH", viewPath, { name: "Kept" });
    expect(named.status).toBe(200);
    expect(named.json!.view).toMatchObject({ name: "Kept" });

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

    const said = await hit(lead, "POST", "/api/concierge/messages", { text: "hello" });
    expect(said.status).toBe(200);
    expect(said.json!.error).toBeUndefined();
    expect(said.json!.disabled).toMatchObject({ code: "NOT_ENABLED" });
  });
});
