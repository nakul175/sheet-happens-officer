// SHO-US-14.10 Saved views (APL-2569).
import { test, expect, zz, type Who, type Later } from "../support";

const day = (n: number) => new Date(Date.now() + 5.5 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
const state = (over: object = {}) => ({ assignee: "", flags: ["overdue"], priority: "", sort: "date", group: "section", ...over });

async function proj(admin: Who, later: Later) {
  const r = await admin.api.post("/api/projects", { name: zz("views"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  await admin.api.post(`/api/projects/${id}/tasks`, { title: zz("late"), dueDate: day(-2) });
  return id;
}

test("AC1: with a filter on, Save view with a name adds a tab that opens in one click", async ({ admin, later }) => {
  const id = await proj(admin, later);
  const p = admin.page;
  const name = zz("Overdue");
  await p.goto(`/projects/${id}?f=overdue`);
  await p.getByRole("button", { name: "Save view" }).click();
  await p.getByLabel("View name").fill(name);
  await p.getByRole("button", { name: "Save view" }).last().click();
  const tab = p.getByRole("group", { name: "Saved views" }).getByRole("button", { name });
  await expect(tab).toBeVisible();
  await p.goto(`/projects/${id}`);
  await p.getByRole("group", { name: "Saved views" }).getByRole("button", { name }).click();
  await expect(p.getByRole("group", { name: "Saved views" }).getByRole("button", { name })).toHaveAttribute("aria-pressed", "true");
  await expect(p.getByText(zz("late")).first()).toBeVisible();
});

test("AC2: renaming or deleting a view changes it for me only", async ({ admin, member, later }) => {
  const id = await proj(admin, later);
  expect((await admin.api.post(`/api/projects/${id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const made = await admin.api.post(`/api/projects/${id}/views`, { name: zz("mine"), state: state() });
  expect(made.status).toBe(201);
  expect((await member.api.get(`/api/projects/${id}/views`)).json.views).toEqual([]);
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  await p.getByRole("group", { name: "Saved views" }).getByRole("button", { name: zz("mine") }).click();
  await p.getByRole("button", { name: "Rename view" }).click();
  await p.getByLabel("View name").fill(zz("renamed"));
  await p.getByRole("button", { name: "Save", exact: true }).click();
  await expect(p.getByRole("group", { name: "Saved views" }).getByRole("button", { name: zz("renamed") })).toBeVisible();
  expect((await member.api.get(`/api/projects/${id}/views`)).json.views).toEqual([]);
  expect((await member.api.patch(`/api/views/${made.json.view.id}`, { name: "hijack" })).status).toBe(404);
  await p.getByRole("button", { name: "Delete view" }).click();
  await p.getByRole("button", { name: "Delete view" }).last().click();
  await expect(p.getByRole("button", { name: zz("renamed") })).toHaveCount(0);
});

test("AC3: with 10 views, Save view is disabled and says why", async ({ admin, later }) => {
  const id = await proj(admin, later);
  for (let i = 0; i < 10; i++) expect((await admin.api.post(`/api/projects/${id}/views`, { name: `${zz("v")} ${i}`, state: state() })).status).toBe(201);
  await admin.page.goto(`/projects/${id}?f=blocked`);
  await expect(admin.page.getByRole("button", { name: "Save view" })).toBeDisabled();
  await expect(admin.page.getByText(/most allowed/)).toBeVisible();
  const extra = await admin.api.post(`/api/projects/${id}/views`, { name: zz("eleven"), state: state() });
  expect(extra.status).toBe(409);
});

test("AC4: a view naming a person who left still opens and says 'person no longer on project'", async ({ admin, member, later }) => {
  const id = await proj(admin, later);
  expect((await admin.api.post(`/api/projects/${id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  expect((await admin.api.post(`/api/projects/${id}/views`, { name: zz("gone"), state: state({ flags: [], assignee: member.user.id }) })).status).toBe(201);
  expect((await admin.api.del(`/api/projects/${id}/members/${member.user.id}`)).status).toBeLessThan(300);
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  await p.getByRole("group", { name: "Saved views" }).getByRole("button", { name: zz("gone") }).click();
  await expect(p.getByText(/no longer on project/).first()).toBeVisible();
});
