// APL-2499 · SHO-US-5.4 Manage a project's Sections
// Acceptance criteria: AC1 add a Section, AC2 delete only after choosing where tasks go, AC3 authority,
// AC4 done Section completes tasks, AC5 limit of 8, AC6 done Section protected (proposed, not confirmed by the owner).
// Data: every project and task is named "ZZ-TEST ..."; projects are archived afterwards.
import { test, expect, zz, type Who, type Page } from "../support";
import { getTask } from "../g2";

async function proj(admin: Who, label: string, later: (f: () => Promise<unknown>) => void) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  const s = (await admin.api.get(`/api/projects/${id}`)).json.project.sections as { id: string; name: string; isDone: boolean }[];
  return { id, todo: s[0].id, doing: s[1].id, done: s.find((x) => x.isDone)!.id };
}
const mk = async (admin: Who, p: string, title: string, extra: Record<string, unknown> = {}) => {
  const r = await admin.api.post(`/api/projects/${p}/tasks`, { title, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
};
const calm = async (page: Page) => { // fold an open concierge so it cannot cover the controls
  const fold = page.locator('aside[aria-label="Concierge"]').getByRole("button", { name: "Collapse" });
  if (await fold.count()) await fold.first().click();
};

test("AC1: a Leader or Admin adds a Section and it appears on the board and in the list", async ({ admin, later }) => {
  const p = await proj(admin, "sec-add", later);
  await admin.page.goto(`/projects/${p.id}`);
  await calm(admin.page);
  await admin.page.getByRole("button", { name: "+ Add section" }).click();
  await admin.page.getByLabel("Section name").fill("Client review");
  await admin.page.getByRole("button", { name: "Add section", exact: true }).click();
  await expect(admin.page.locator('section[aria-label="Client review"]')).toBeVisible(); // list
  await admin.page.getByRole("tab", { name: "Board", exact: true }).click();
  await expect(admin.page.locator('.col[aria-label="Client review"]')).toBeVisible(); // board
});

test("AC2: deleting a Section with tasks needs a destination and never deletes the tasks", async ({ admin, later }) => {
  const p = await proj(admin, "sec-delete", later);
  const t = await mk(admin, p.id, zz("stays"), { dueDate: "2026-11-03", sectionId: p.doing });
  const noDest = await admin.api.del(`/api/projects/${p.id}/sections/${p.doing}`);
  expect(noDest.status).toBe(400);
  expect((await admin.api.get(`/api/tasks/${t}`)).status).toBe(200);
  // Through the screen: the dialog asks where the tasks go.
  await admin.page.goto(`/projects/${p.id}`);
  await calm(admin.page);
  await admin.page.getByRole("button", { name: "Section menu for In progress" }).click();
  await admin.page.getByRole("menuitem", { name: /^Delete/ }).click();
  await expect(admin.page.getByText("This section has 1 task. Choose where they go.")).toBeVisible();
  await admin.page.getByLabel("Move its tasks to").selectOption({ label: "To do" });
  await admin.page.getByRole("button", { name: "Delete section" }).click();
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${t}`)).json.task.sectionId).toBe(p.todo);
});

test("AC3: an Editor or Viewer cannot change Sections", async ({ admin, member, later }) => {
  const p = await proj(admin, "sec-authority", later);
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p.id}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  expect((await member.api.post(`/api/projects/${p.id}/sections`, { name: "Nope" })).status).toBe(403);
  expect((await member.api.patch(`/api/projects/${p.id}/sections/${p.todo}`, { name: "Renamed" })).status).toBe(403);
  expect((await member.api.del(`/api/projects/${p.id}/sections/${p.doing}?moveTo=${p.todo}`)).status).toBe(403);
  await member.page.goto(`/projects/${p.id}`);
  await expect(member.page.getByText("Only the Leader and Admins can change sections.")).toBeVisible();
  await expect(member.page.getByRole("button", { name: "+ Add section" })).toHaveCount(0);
  expect((await admin.api.patch(`/api/projects/${p.id}/members/${member.user.id}`, { role: "VIEWER" })).status).toBe(200);
  expect((await member.api.post(`/api/projects/${p.id}/sections`, { name: "Nope" })).status).toBe(403);
});

test("AC4: tasks moved into the done Section count as complete", async ({ admin, later }) => {
  const p = await proj(admin, "sec-done", later);
  const t = await mk(admin, p.id, zz("to finish"), { dueDate: "2026-11-03" });
  expect((await admin.api.get(`/api/tasks/${t}`)).json.task.completedAt).toBeNull();
  expect((await admin.api.post(`/api/tasks/${t}/move`, { sectionId: p.done, expectedUpdatedAt: (await getTask(admin, t)).updatedAt })).status).toBe(200);
  expect((await admin.api.get(`/api/tasks/${t}`)).json.task.completedAt).not.toBeNull();
  expect((await admin.api.post(`/api/tasks/${t}/move`, { sectionId: p.doing, expectedUpdatedAt: (await getTask(admin, t)).updatedAt })).status).toBe(200);
  expect((await admin.api.get(`/api/tasks/${t}`)).json.task.completedAt).toBeNull();
});

test("AC5: with 8 Sections, Add section is disabled with the limit message", async ({ admin, later }) => {
  const p = await proj(admin, "sec-limit", later);
  for (let i = 0; i < 5; i++) expect((await admin.api.post(`/api/projects/${p.id}/sections`, { name: `S${i}` })).status).toBe(201);
  const ninth = await admin.api.post(`/api/projects/${p.id}/sections`, { name: "Ninth" });
  expect(ninth.status).toBe(409);
  expect(ninth.json.error).toBe("A project can have up to 8 sections.");
  await admin.page.goto(`/projects/${p.id}`);
  await calm(admin.page);
  await expect(admin.page.getByRole("button", { name: "+ Add section" })).toBeDisabled();
  await expect(admin.page.getByText("A project can have up to 8 sections.")).toBeVisible();
});

test("AC6: the done Section cannot be deleted or unmarked, and the last Section cannot be deleted (proposed AC)", async ({ admin, later }) => {
  const p = await proj(admin, "sec-protected", later);
  expect((await admin.api.del(`/api/projects/${p.id}/sections/${p.done}?moveTo=${p.todo}`)).status).toBe(409);
  expect((await admin.api.patch(`/api/projects/${p.id}/sections/${p.done}`, { isDone: false })).status).toBe(409);
  // delete the other two Sections; deleting the last remaining one must be refused
  expect((await admin.api.del(`/api/projects/${p.id}/sections/${p.todo}?moveTo=${p.doing}`)).status).toBe(204);
  expect((await admin.api.del(`/api/projects/${p.id}/sections/${p.doing}?moveTo=${p.done}`)).status).toBe(204);
  const last = await admin.api.del(`/api/projects/${p.id}/sections/${p.done}?moveTo=${p.done}`);
  expect(last.status).toBeGreaterThanOrEqual(400);
  const left = (await admin.api.get(`/api/projects/${p.id}`)).json.project.sections;
  expect(left).toHaveLength(1);
});
