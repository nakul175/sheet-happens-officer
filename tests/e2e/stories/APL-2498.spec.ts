// APL-2498 · SHO-US-5.3 Project board with Sections
// Acceptance criteria: AC1 drag saves the Section, AC2 Viewer cannot drag, AC3 four columns fit at 1280 px,
// AC4 order by due date, AC5 Done column collapsed to 10, AC6 completion rules and archived project.
// Data: every project and task is named "ZZ-TEST ..."; projects are archived afterwards.
import { test, expect, zz, type Who, type Page } from "../support";
import { getTask } from "../g2";

const ist = (d: number) => new Date(Date.now() + 5.5 * 3600e3 + d * 864e5).toISOString().slice(0, 10);

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
const board = async (page: Page, id: string) => {
  await page.goto(`/projects/${id}`);
  // An open concierge (left expanded by earlier chats) can sit over the tabs and lower cards: fold it first.
  const fold = page.locator('aside[aria-label="Concierge"]').getByRole("button", { name: "Collapse" });
  await page.getByRole("tab", { name: "List", exact: true }).waitFor();
  if (await fold.count()) await fold.first().click();
  await page.getByRole("tab", { name: "Board", exact: true }).click();
  await expect(page.locator(".board")).toBeVisible();
  if (await fold.count()) await fold.first().click();
};

test("AC1: an Editor drags a card to another Section, it is saved and survives a reload", async ({ admin, later }) => {
  const p = await proj(admin, "board-drag", later);
  const t = await mk(admin, p.id, zz("dragme"), { dueDate: ist(2) });
  await board(admin.page, p.id);
  await admin.page.locator(".bcard", { hasText: zz("dragme") }).dragTo(admin.page.locator(`.col[aria-label="In progress"]`));
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${t}`)).json.task.sectionId).toBe(p.doing);
  await board(admin.page, p.id);
  await expect(admin.page.locator(`.col[aria-label="In progress"] .bcard`, { hasText: zz("dragme") })).toBeVisible();
});

test("AC2: a Viewer cannot drag cards", async ({ admin, member, later }) => {
  const p = await proj(admin, "board-viewer", later);
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p.id}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  const t = await mk(admin, p.id, zz("viewer card"));
  await board(member.page, p.id);
  const card = member.page.locator(".bcard", { hasText: zz("viewer card") });
  await expect(card).toBeVisible();
  await expect(card).not.toHaveAttribute("draggable", "true");
  expect((await member.api.post(`/api/tasks/${t}/move`, { sectionId: p.doing, expectedUpdatedAt: (await getTask(member, t)).updatedAt })).status).toBe(403);
});

test("AC3: four columns show at 1280 px without the page scrolling sideways", async ({ admin, later }) => {
  const p = await proj(admin, "board-width", later);
  expect((await admin.api.post(`/api/projects/${p.id}/sections`, { name: "Client review" })).status).toBe(201);
  await mk(admin, p.id, zz("w"));
  await admin.page.setViewportSize({ width: 1280, height: 800 });
  await board(admin.page, p.id);
  await expect(admin.page.locator(".board .col")).toHaveCount(4);
  const fits = await admin.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits, "no horizontal page scroll").toBe(true);
  const b = await admin.page.locator(".board").evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1);
  expect(b, "all four columns are inside the board without scrolling").toBe(true);
});

test("AC4: cards in a column are ordered by due date, soonest first, undated last", async ({ admin, later }) => {
  const p = await proj(admin, "board-order", later);
  await mk(admin, p.id, zz("none"));
  await mk(admin, p.id, zz("far"), { dueDate: ist(9) });
  await mk(admin, p.id, zz("near"), { dueDate: ist(1) });
  await board(admin.page, p.id);
  await expect(admin.page.locator(`.col[aria-label="To do"] .bcard > div:first-child`)).toHaveText([zz("near"), zz("far"), zz("none")]);
});

test("AC5: a Done column with more than 10 shows the 10 most recent and Show all reveals the rest", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const p = await proj(admin, "board-done", later);
  for (let i = 1; i <= 12; i++) {
    const id = await mk(admin, p.id, zz(`b${i}`));
    expect((await admin.api.post(`/api/tasks/${id}/complete`, { expectedUpdatedAt: (await getTask(admin, id)).updatedAt })).status).toBe(200);
  }
  await board(admin.page, p.id);
  const col = admin.page.locator(`.col[aria-label="Done"]`);
  await expect(col.locator(".bcard")).toHaveCount(10);
  await col.getByRole("button", { name: "Show all 12" }).click();
  await expect(col.locator(".bcard")).toHaveCount(12);
});

test("AC6: someone who may not close a task cannot move it to Done, and an archived project cannot be moved", async ({ admin, member, later }) => {
  const p = await proj(admin, "board-rules", later);
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p.id}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  // The approver is the admin, so the assignee (member) may not close it.
  const t = await mk(admin, p.id, zz("needs approval"), { assigneeId: member.user.id, approverId: admin.user.id });
  const refused = await member.api.post(`/api/tasks/${t}/move`, { sectionId: p.done, expectedUpdatedAt: (await getTask(member, t)).updatedAt });
  expect([403, 409]).toContain(refused.status);
  expect((await admin.api.get(`/api/tasks/${t}`)).json.task.completedAt).toBeNull();
  // Ordinary move still works for the same person.
  expect((await member.api.post(`/api/tasks/${t}/move`, { sectionId: p.doing, expectedUpdatedAt: (await getTask(member, t)).updatedAt })).status).toBe(200);
  // Archived: no card can be moved.
  expect((await admin.api.post(`/api/projects/${p.id}/archive`)).status).toBe(200);
  expect((await admin.api.post(`/api/tasks/${t}/move`, { sectionId: p.todo, expectedUpdatedAt: (await getTask(admin, t)).updatedAt })).status).toBe(409);
});
