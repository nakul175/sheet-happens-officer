// SHO-E11 Organisations and contacts (Linear APL-2524).
// One test per acceptance criterion. People are nakul17+ aliases signed in with SHO_QA_PASS.
// Organisations, contacts, notes and tasks are ZZ-TEST and archived or removed afterwards.
// Pam left no qa:TC cases on this issue.
import { test, expect, zz, RUN } from "../support";
import { newProject, newTask, ymd, type Who } from "../g2";
import { orgPage } from "../helpers/claude-a";
import { raw } from "../helpers/jim-http";
import { QA_PASS, cast, gateFile, noSecret, track } from "../helpers/qa-alias";

gateFile();

type Later = (fn: () => Promise<unknown>) => void;
type Org = {
  id: string; name: string; parentId: string | null; archived: boolean; canEdit: boolean;
  path: { id: string; name: string }[];
  children: { id: string; name: string }[];
  deals: { projectId: string; name: string; role: string }[];
  contacts: { id: string; name: string; email: string | null }[];
  notes: { id: string; text: string; date: string; deal: { id: string } | null }[];
  tasks: { id: string; title: string }[];
  tree: { id: string; name: string; children: { id: string; name: string }[] } | null;
};

async function makeOrg(who: Who, later: Later, label: string, extra: Record<string, unknown> = {}) {
  const name = zz(label);
  const r = await who.api.post("/api/orgs", { name, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.organisation.id as string;
  later(() => who.api.post(`/api/orgs/${id}/archive`, { archive: true }));
  return { id, name };
}

const load = async (who: Who, id: string) => orgPage(who.api, id) as Promise<Org>;

test("AC1: an organisation can sit under a parent, and both appear in Accounts and in the tree", async ({ browser, later }) => {
  test.setTimeout(120_000);
  const { admin } = await cast(browser, later, []);
  const parent = await makeOrg(admin, later, "e11 parent");
  const child = await makeOrg(admin, later, "e11 child", { parentId: parent.id });
  const bare = await makeOrg(admin, later, "e11 bare");
  expect((await load(admin, bare.id)).parentId).toBeNull();
  const childOrg = await load(admin, child.id);
  expect(childOrg.parentId).toBe(parent.id);
  expect(childOrg.path.map((p) => p.id)).toEqual([parent.id, child.id]);
  const listed = (await admin.api.get("/api/orgs")).json.organisations as { id: string }[];
  expect(listed.some((o) => o.id === parent.id)).toBe(true);
  expect(listed.some((o) => o.id === child.id)).toBe(true);
  await admin.page.goto("/accounts");
  await admin.page.getByLabel("Search organisations").fill(child.name);
  await expect(admin.page.getByRole("link", { name: child.name })).toBeVisible();
  await admin.page.goto(`/accounts/${parent.id}`);
  const tree = admin.page.locator(".card", { has: admin.page.getByRole("link", { name: child.name }) });
  await expect(tree.getByRole("link", { name: child.name })).toBeVisible();
  await expect(admin.page.getByRole("heading", { name: parent.name })).toBeVisible();
});

test("AC2: a contact on the organisation page is not a user and cannot sign in", async ({ browser, later }) => {
  test.setTimeout(120_000);
  const { admin } = await cast(browser, later, []);
  const org = await makeOrg(admin, later, "e11 contacts");
  const email = `nakul17+zzc-${RUN}@gmail.com`;
  const name = zz("contact person");
  const made = await admin.api.post(`/api/orgs/${org.id}/contacts`, { name, email });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const contactId = made.json.contact.id as string;
  later(() => admin.api.del(`/api/contacts/${contactId}`));
  const page = await load(admin, org.id);
  expect(page.contacts.some((c) => c.id === contactId && c.email === email)).toBe(true);
  const people = (await admin.api.get("/api/team")).json.people as { email: string }[];
  expect(people.some((p) => p.email === email)).toBe(false);
  await admin.page.goto(`/accounts/${org.id}`);
  await expect(admin.page.locator(".item b", { hasText: name })).toBeVisible();
  const anon = await browser.newContext();
  track(later, anon);
  const sign = await anon.request.post("/api/auth/signin", { data: { email, password: QA_PASS } });
  const body = await sign.text();
  expect(body.includes(QA_PASS)).toBe(false);
  expect(sign.status(), body).toBe(401);
  expect(body).toContain("Email or password is incorrect.");
});

test("AC3: a note sits on the timeline newest first, and removing it can be undone", async ({ browser, later }) => {
  test.setTimeout(120_000);
  const { admin } = await cast(browser, later, []);
  const org = await makeOrg(admin, later, "e11 notes");
  const older = zz("older note");
  const newer = zz("newer note");
  expect((await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "CALL", date: ymd(-4), text: older })).status).toBe(201);
  const added = await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "MEETING", date: ymd(0), text: newer });
  expect(added.status, JSON.stringify(added.json)).toBe(201);
  const notes = (await load(admin, org.id)).notes;
  expect(notes.map((n) => n.text)).toEqual([newer, older]);
  const id = notes.find((n) => n.text === newer)!.id;
  const removed = await raw(admin, "DELETE", `/api/notes/${id}`);
  expect(removed.status).toBe(204);
  expect(removed.headers["x-undo-id"]).toBeTruthy();
  expect(removed.headers["x-undo-label"]).toBe("Note deleted");
  expect((await load(admin, org.id)).notes.map((n) => n.text)).toEqual([older]);
  const undone = await admin.api.post(`/api/actions/${removed.headers["x-undo-id"]}/undo`, { anyway: false });
  expect(undone.status, JSON.stringify(undone.json)).toBe(200);
  noSecret(JSON.stringify(undone.json));
  expect((await load(admin, org.id)).notes.map((n) => n.text)).toEqual([newer, older]);
});

test("AC4: a task linked to an organisation or a contact shows on the task and on the organisation for people who can see the task", async ({ browser, later }) => {
  test.setTimeout(180_000);
  const { admin, people: [insider, outsider] } = await cast(browser, later, ["linked", "outside"]);
  const org = await makeOrg(admin, later, "e11 linked");
  const contactName = zz("linked contact");
  const contact = await admin.api.post(`/api/orgs/${org.id}/contacts`, { name: contactName });
  expect(contact.status, JSON.stringify(contact.json)).toBe(201);
  const contactId = contact.json.contact.id as string;
  later(() => admin.api.del(`/api/contacts/${contactId}`));
  const project = await newProject(admin, later, { label: "e11 link project", members: [{ who: insider, role: "EDITOR" }] });
  const title = zz("linked task");
  const taskId = await newTask(admin, project.id, { dueDate: "2031-03-20", title, assigneeId: insider.user.id });
  expect((await admin.api.post(`/api/tasks/${taskId}/links`, { organisationId: org.id })).status).toBe(201);
  expect((await admin.api.post(`/api/tasks/${taskId}/links`, { contactId })).status).toBe(201);
  const task = (await insider.api.get(`/api/tasks/${taskId}`)).json.task as { links: { organisation: { id: string } | null; contact: { id: string } | null }[] };
  expect(task.links.some((l) => l.organisation?.id === org.id)).toBe(true);
  expect(task.links.some((l) => l.contact?.id === contactId)).toBe(true);
  expect((await load(insider, org.id)).tasks.some((t) => t.id === taskId)).toBe(true);
  expect((await load(outsider, org.id)).tasks.some((t) => t.id === taskId)).toBe(false);
  await insider.page.goto(`/accounts/${org.id}`);
  await expect(insider.page.getByRole("link", { name: title })).toBeVisible();
  await outsider.page.goto(`/accounts/${org.id}`);
  await expect(outsider.page.getByText("No linked tasks you can see.")).toBeVisible();
  await insider.page.goto(`/projects/${project.id}?task=${taskId}`);
  const dialog = insider.page.getByRole("dialog", { name: "Task" });
  await expect(dialog.getByRole("link", { name: org.name })).toBeVisible();
  await expect(dialog.getByRole("link", { name: contactName })).toBeVisible();
});

test("AC5: every signed-in member can see organisations and contacts, and only the creator and Admins can change them", async ({ browser, later }) => {
  test.setTimeout(180_000);
  const { admin, people: [member] } = await cast(browser, later, ["reader"]);
  const shared = await makeOrg(admin, later, "e11 shared");
  const seen = (await member.api.get("/api/orgs")).json.organisations as { id: string }[];
  expect(seen.some((o) => o.id === shared.id)).toBe(true);
  expect((await load(member, shared.id)).canEdit).toBe(false);
  const refused = await member.api.patch(`/api/orgs/${shared.id}`, { name: zz("renamed by member") });
  expect(refused.status).toBe(403);
  expect((await member.api.post(`/api/orgs/${shared.id}/archive`, { archive: true })).status).toBe(403);
  const own = await makeOrg(member, later, "e11 own");
  const renamed = zz("renamed by creator");
  expect((await member.api.patch(`/api/orgs/${own.id}`, { name: renamed })).status).toBe(200);
  expect((await load(member, own.id)).name).toBe(renamed);
  const byAdmin = zz("renamed by admin");
  expect((await admin.api.patch(`/api/orgs/${own.id}`, { name: byAdmin })).status).toBe(200);
  expect((await load(admin, own.id)).name).toBe(byAdmin);
  const contact = await member.api.post(`/api/orgs/${own.id}/contacts`, { name: zz("own contact") });
  expect(contact.status).toBe(201);
  later(() => admin.api.del(`/api/contacts/${contact.json.contact.id}`));
  expect((await load(admin, own.id)).contacts.some((c) => c.id === contact.json.contact.id)).toBe(true);
});

test("AC6: an organisation is archived rather than deleted, the change is in Admin-only History, and the archive can be undone", async ({ browser, later }) => {
  test.setTimeout(120_000);
  const { admin, people: [member] } = await cast(browser, later, ["history"]);
  const org = await makeOrg(admin, later, "e11 archive");
  expect((await admin.api.post(`/api/orgs/${org.id}/archive`, { archive: true })).status).toBe(200);
  const archived = await load(admin, org.id);
  expect(archived.id).toBe(org.id);
  expect(archived.archived).toBe(true);
  const hidden = (await admin.api.get("/api/orgs")).json.organisations as { id: string }[];
  expect(hidden.some((o) => o.id === org.id)).toBe(false);
  const kept = (await admin.api.get("/api/orgs?archived=true")).json.organisations as { id: string }[];
  expect(kept.some((o) => o.id === org.id)).toBe(true);
  const memberHist = await member.api.get(`/api/orgs/${org.id}/history`);
  expect(memberHist.status).toBe(404);
  expect(memberHist.json.error).toBe("Page not found");
  const adminHist = await admin.api.get(`/api/orgs/${org.id}/history`);
  expect(adminHist.status).toBe(200);
  const items = adminHist.json.items as { action: string }[];
  expect(items.some((h) => h.action === "organisation.archived")).toBe(true);
  await admin.page.goto(`/accounts/${org.id}`);
  await admin.page.getByRole("button", { name: "History" }).click();
  await expect(admin.page.getByText("organisation.archived")).toBeVisible();
  expect((await admin.api.post(`/api/orgs/${org.id}/archive`, { archive: false })).status).toBe(200);
  expect((await load(admin, org.id)).archived).toBe(false);
  const back = (await admin.api.get("/api/orgs")).json.organisations as { id: string }[];
  expect(back.some((o) => o.id === org.id)).toBe(true);
});

test("AC7: the organisation page lists a deal, its notes and linked tasks only for someone on that project", async ({ browser, later }) => {
  test.setTimeout(180_000);
  const { admin, people: [member] } = await cast(browser, later, ["deal reader"]);
  const org = await makeOrg(admin, later, "e11 deals");
  const pipes = (await admin.api.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
  const pro = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
  const dealName = zz("e11 org deal");
  const deal = await admin.api.post("/api/deals", {
    name: dealName, organisationId: org.id, pipelineId: pro.id, leaderId: admin.user.id, whyPursue: "ZZ-TEST fit",
    nextStep: { title: zz("e11 step"), dueDate: ymd(3) },
  });
  expect(deal.status, JSON.stringify(deal.json)).toBe(201);
  const dealId = deal.json.deal.id as string;
  later(() => admin.api.post(`/api/projects/${dealId}/archive`));
  const note = zz("deal only note");
  expect((await admin.api.post(`/api/orgs/${org.id}/notes`, { kind: "CALL", date: ymd(0), text: note, projectId: dealId })).status).toBe(201);
  const project = await newProject(admin, later, { label: "e11 hidden project" });
  const title = zz("hidden linked");
  const taskId = await newTask(admin, project.id, { dueDate: "2031-03-20", title, assigneeId: admin.user.id });
  expect((await admin.api.post(`/api/tasks/${taskId}/links`, { organisationId: org.id })).status).toBe(201);

  const before = await load(member, org.id);
  expect(before.deals.some((d) => d.projectId === dealId)).toBe(false);
  expect(before.notes.some((n) => n.text === note)).toBe(false);
  expect(before.tasks.some((t) => t.id === taskId)).toBe(false);
  const adminView = await load(admin, org.id);
  expect(adminView.deals.some((d) => d.projectId === dealId && d.role === "BUYER")).toBe(true);
  expect(adminView.notes.some((n) => n.text === note)).toBe(true);
  expect(adminView.tasks.some((t) => t.id === taskId)).toBe(true);

  expect((await admin.api.post(`/api/projects/${dealId}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  expect((await admin.api.post(`/api/projects/${project.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  const after = await load(member, org.id);
  expect(after.deals.some((d) => d.projectId === dealId)).toBe(true);
  expect(after.notes.some((n) => n.text === note)).toBe(true);
  expect(after.tasks.some((t) => t.id === taskId)).toBe(true);
  await member.page.goto(`/accounts/${org.id}`);
  await expect(member.page.getByRole("table").getByRole("link", { name: dealName })).toBeVisible();
  await expect(member.page.locator(".item", { hasText: note })).toBeVisible();
  await expect(member.page.getByRole("link", { name: title })).toBeVisible();
});
