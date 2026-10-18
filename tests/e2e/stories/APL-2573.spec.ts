// SHO-US-14.14 Readable activity (APL-2573). AC3 needs the optional Member account.
import { test, expect, zz } from "../support";

const year = new Date(Date.now() + 5.5 * 3600_000).getUTCFullYear();

async function seed(admin: any, later: any, member?: any) {
  const r = await admin.api.post("/api/projects", { name: zz("activity"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  if (member) expect((await admin.api.post(`/api/projects/${id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  return id;
}
type Row = { who: string; what: string; when: string; via: string; undo: string };
const rows = async (a: any, id: string) => (await a.api.get(`/api/projects/${id}/activity`)).json.items as Row[];

test("AC1: no activity row has a database id, a field name or an ISO timestamp", async ({ admin, later }) => {
  const id = await seed(admin, later);
  const t = (await admin.api.post(`/api/projects/${id}/tasks`, { title: zz("readable"), dueDate: `${year}-12-10`, priority: "MEDIUM" })).json.task.id;
  expect((await admin.api.patch(`/api/tasks/${t}`, { dueDate: `${year}-12-14`, priority: "HIGH" })).status).toBe(200);
  expect((await admin.api.del(`/api/tasks/${t}`)).status).toBeLessThan(300);
  const list = await rows(admin, id);
  expect(list.length).toBeGreaterThan(0);
  const blob = JSON.stringify(list.map(({ who, what, when, via }) => ({ who, what, when, via })));
  expect(blob).not.toMatch(/cm[a-z0-9]{20,}/);
  expect(blob).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
  expect(blob).not.toMatch(/deletedAt|sectionId|assigneeId|dueDate/);
  await admin.page.goto(`/projects/${id}/activity`);
  await expect(admin.page.getByText(zz("readable")).first()).toBeVisible();
  const text = await admin.page.locator("main.content").last().innerText();
  expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:|deletedAt|sectionId|assigneeId/);
});

test("AC2: a date change reads 'changed due date from 10 Dec to 14 Dec'", async ({ admin, later }) => {
  const id = await seed(admin, later);
  const t = (await admin.api.post(`/api/projects/${id}/tasks`, { title: zz("datechange"), dueDate: `${year}-12-10` })).json.task.id;
  expect((await admin.api.patch(`/api/tasks/${t}`, { dueDate: `${year}-12-14` })).status).toBe(200);
  await admin.page.goto(`/projects/${id}/activity`);
  await expect(admin.page.getByText(`changed due date from 10 Dec to 14 Dec on "${zz("datechange")}"`)).toBeVisible();
});

test("AC3: an Editor sees activity of tasks they are on, not the whole project", async ({ admin, member, later }) => {
  const id = await seed(admin, later, member);
  const mine = (await admin.api.post(`/api/projects/${id}/tasks`, { title: zz("mine"), assigneeId: member.user.id })).json.task.id;
  const theirs = (await admin.api.post(`/api/projects/${id}/tasks`, { title: zz("theirs"), assigneeId: admin.user.id })).json.task.id;
  await admin.api.patch(`/api/tasks/${mine}`, { priority: "HIGH" });
  await admin.api.patch(`/api/tasks/${theirs}`, { priority: "HIGH" });
  const all = await rows(admin, id);
  expect(all.some((r) => r.what.includes(zz("theirs")))).toBe(true);
  const seen = await rows(member, id);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((r) => r.what.includes(zz("mine")))).toBe(true);
  await member.page.goto(`/projects/${id}/activity`);
  await expect(member.page.getByText(zz("mine")).first()).toBeVisible();
  await expect(member.page.getByText(zz("theirs"))).toHaveCount(0);
});

test("AC4: HOW is not shown on rows made on screen", async ({ admin, later }) => {
  const id = await seed(admin, later);
  await admin.api.post(`/api/projects/${id}/tasks`, { title: zz("screenonly") });
  await admin.page.goto(`/projects/${id}/activity`);
  const row = admin.page.locator(".act").filter({ hasText: zz("screenonly") }).first();
  await expect(row).toBeVisible();
  await expect(row).not.toContainText(/HOW|on screen|via screen/i);
  await expect(row.locator(".chip")).toHaveCount(0); // only "via concierge" would show a chip
});

test("AC5: Undo stays on the row", async ({ admin, later }) => {
  const id = await seed(admin, later);
  const t = (await admin.api.post(`/api/projects/${id}/tasks`, { title: zz("undoable"), priority: "LOW" })).json.task.id;
  expect((await admin.api.patch(`/api/tasks/${t}`, { priority: "HIGH" })).status).toBe(200);
  await admin.page.goto(`/projects/${id}/activity`);
  const row = admin.page.locator(".act").filter({ hasText: "changed priority" }).filter({ hasText: zz("undoable") }).first();
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "Undo" })).toBeVisible();
});
