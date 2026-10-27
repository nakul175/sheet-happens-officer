// SHO-US-11.4 Link tasks to an organisation or contact  (Linear APL-2535)
// Pam left no qa:TC id. Each title says qa:TC missing. The annotation is qa:TC with description missing. An AC number is not a TC id.
import { expect, test, zz, type Json, type Who } from "../support";
import { gateFile } from "../helpers/qa-alias";

gateFile();

let n = 0;
async function setup(admin: Who, later: (f: () => Promise<unknown>) => void) {
  const org = (await admin.api.post("/api/orgs", { name: `${zz("org")} ${n++}` })).json.organisation.id as string;
  later(() => admin.api.post(`/api/orgs/${org}/archive`, { archive: true }));
  const contact = (await admin.api.post(`/api/orgs/${org}/contacts`, { name: `${zz("contact")} ${n}` })).json.contact.id as string;
  later(() => admin.api.del(`/api/contacts/${contact}`));
  const pr = await admin.api.post("/api/projects", { name: zz("proj"), leaderId: admin.user.id });
  expect(pr.status).toBe(201);
  const projectId = pr.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));
  const t = await admin.api.post(`/api/projects/${projectId}/tasks`, { title: zz("linked task") });
  expect(t.status).toBe(201);
  const taskId = t.json.task.id as string;
  later(() => admin.api.del(`/api/tasks/${taskId}`));
  return { org, contact, projectId, taskId };
}

// qa:TC missing
test("AC1: an Editor links an organisation or a contact and it shows on the task qa:TC missing", async ({ admin, later }) => {
  const s = await setup(admin, later);
  expect((await admin.api.post(`/api/tasks/${s.taskId}/links`, { organisationId: s.org })).status).toBe(201);
  expect((await admin.api.post(`/api/tasks/${s.taskId}/links`, { contactId: s.contact })).status).toBe(201);
  const shown = (await admin.api.get(`/api/tasks/${s.taskId}`)).json.task.links as Json[];
  expect(shown).toHaveLength(2);
  // On screen: the task overlay has a Links section.
  await admin.page.goto(`/projects/${s.projectId}?task=${s.taskId}`);
  const dialog = admin.page.getByRole("dialog", { name: "Task" });
  await expect(dialog.getByRole("link", { name: new RegExp(zz("org")) })).toBeVisible();
});
// qa:TC missing
test("AC2: 'Tasks linked here' on the organisation lists the linked task, including via its contacts qa:TC missing", async ({ admin, later }) => {
  const s = await setup(admin, later);
  expect((await admin.api.post(`/api/tasks/${s.taskId}/links`, { contactId: s.contact })).status).toBe(201);
  await admin.page.goto(`/accounts/${s.org}`);
  await expect(admin.page.getByRole("link", { name: new RegExp(zz("linked task")) })).toBeVisible();
});
// qa:TC missing
test("AC3: removing a link leaves the task unchanged qa:TC missing", async ({ admin, later }) => {
  const s = await setup(admin, later);
  const l = await admin.api.post(`/api/tasks/${s.taskId}/links`, { organisationId: s.org });
  const linkId = l.json.link.id as string;
  expect((await admin.api.del(`/api/tasks/${s.taskId}/links/${linkId}`)).status).toBeLessThan(300);
  const t = (await admin.api.get(`/api/tasks/${s.taskId}`)).json.task;
  expect(t.title).toBe(zz("linked task"));
  expect(t.links).toHaveLength(0);
});

// qa:TC missing
test("AC4: a task in Trash or in an archived project is not listed on the organisation qa:TC missing", async ({ admin, later }) => {
  const s = await setup(admin, later);
  await admin.api.post(`/api/tasks/${s.taskId}/links`, { organisationId: s.org });
  const listed = async () => JSON.stringify((await admin.api.get(`/api/orgs/${s.org}`)).json);
  expect(await listed()).toContain(zz("linked task"));
  expect((await admin.api.del(`/api/tasks/${s.taskId}`)).status).toBeLessThan(300);
  expect(await listed()).not.toContain(zz("linked task"));
  // A task in an archived project is left out too.
  const t2 = await admin.api.post(`/api/projects/${s.projectId}/tasks`, { title: zz("second linked task") });
  await admin.api.post(`/api/tasks/${t2.json.task.id}/links`, { organisationId: s.org });
  expect(await listed()).toContain(zz("second linked task"));
  expect((await admin.api.post(`/api/projects/${s.projectId}/archive`)).status).toBeLessThan(300);
  expect(await listed()).not.toContain(zz("second linked task"));
});

// qa:TC missing
test("AC5: the server refuses a Viewer's link change qa:TC missing", async ({ admin, member, later }) => {
  const s = await setup(admin, later);
  const add = await admin.api.post(`/api/projects/${s.projectId}/members`, { userId: member.user.id, role: "VIEWER" });
  expect(add.status).toBe(201);
  const r = await member.api.post(`/api/tasks/${s.taskId}/links`, { organisationId: s.org });
  expect(r.status).toBe(403);
});

// qa:TC missing
test("AC5 (screen): the Links section renders read-only for a Viewer qa:TC missing", async ({ admin, member, later }) => {
  const s = await setup(admin, later);
  expect((await admin.api.post(`/api/projects/${s.projectId}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  const orgName = (await admin.api.get(`/api/orgs/${s.org}`)).json.organisation.name as string;
  expect((await admin.api.post(`/api/tasks/${s.taskId}/links`, { organisationId: s.org })).status).toBe(201);
  await member.page.goto(`/projects/${s.projectId}?task=${s.taskId}`);
  const links = member.page.getByRole("dialog", { name: "Task" }).getByText("Links", { exact: true }).locator("xpath=parent::div");
  await expect(links).toBeVisible();
  await expect(links.getByRole("link", { name: orgName })).toBeVisible();
  await expect(links.getByRole("button", { name: "+ Link" })).toHaveCount(0);
  await expect(links.getByRole("button", { name: "Remove link" })).toHaveCount(0);
});
