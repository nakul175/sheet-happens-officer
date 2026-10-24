// APL-2497 · SHO-US-5.2 Project list view
// Acceptance criteria: AC1 sections ordered by due date, AC2 paging, AC3 non-member, AC4 Done section collapsed to 10,
// AC5 archived project read-only.
// Data: every project and task is named "ZZ-TEST ..."; projects are archived afterwards.
import { test, expect, zz, type Who } from "../support";
import { getTask } from "../g2";

const ist = (d: number) => new Date(Date.now() + 5.5 * 3600e3 + d * 864e5).toISOString().slice(0, 10);

async function proj(admin: Who, label: string, later: (f: () => Promise<unknown>) => void) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  const s = (await admin.api.get(`/api/projects/${id}`)).json.project.sections as { id: string; isDone: boolean }[];
  return { id, todo: s[0].id, done: s.find((x) => x.isDone)!.id };
}
const mk = async (admin: Who, p: string, title: string, extra: Record<string, unknown> = {}) => {
  const r = await admin.api.post(`/api/projects/${p}/tasks`, { title, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
};

test("AC1: tasks sit under their Sections, soonest due first, undated last", async ({ admin, later }) => {
  const p = await proj(admin, "list-order", later);
  const c = await mk(admin, p.id, zz("no date"), { dueDate: "2026-11-03" });
  expect((await admin.api.patch(`/api/tasks/${c}`, { dueDate: null, expectedUpdatedAt: (await admin.api.get(`/api/tasks/${c}`)).json.task.updatedAt })).status).toBe(200);
  expect((await admin.api.get(`/api/tasks/${c}`)).json.task.dueDate).toBeNull();
  const b = await mk(admin, p.id, zz("in 5"), { dueDate: ist(5) });
  const a = await mk(admin, p.id, zz("in 1"), { dueDate: ist(1) });
  const api = (await admin.api.get(`/api/projects/${p.id}/tasks`)).json.sections.find((s: { id: string }) => s.id === p.todo);
  expect(api.tasks.map((t: { id: string }) => t.id)).toEqual([a, b, c]);
  await admin.page.goto(`/projects/${p.id}`);
  const rows = admin.page.locator(`section[aria-label="To do"] .item.click .ttl`);
  await expect(rows).toHaveText([zz("in 1"), zz("in 5"), zz("no date")]);
});

test("AC2: a long list loads page by page in the same order", async ({ admin, later }) => {
  const p = await proj(admin, "list-paging", later);
  const made: string[] = [];
  for (let i = 1; i <= 7; i++) made.push(await mk(admin, p.id, zz(`p${i}`), { dueDate: ist(i) }));
  const first = (await admin.api.get(`/api/projects/${p.id}/tasks?sectionId=${p.todo}&limit=3`)).json.sections[0];
  expect(first.tasks).toHaveLength(3);
  expect(first.nextCursor).toBeTruthy();
  const second = (await admin.api.get(`/api/projects/${p.id}/tasks?sectionId=${p.todo}&limit=3&cursor=${first.nextCursor}`)).json.sections[0];
  const third = (await admin.api.get(`/api/projects/${p.id}/tasks?sectionId=${p.todo}&limit=3&cursor=${second.nextCursor}`)).json.sections[0];
  const all = [...first.tasks, ...second.tasks, ...third.tasks].map((t) => t.id);
  expect(all).toEqual(made); // same order, no repeats, none skipped
});

test("AC3: a person who is not a member cannot load the project", async ({ admin, member, later }) => {
  const p = await proj(admin, "list-private", later);
  await mk(admin, p.id, zz("secret row"), { dueDate: "2026-11-03" });
  expect((await member.api.get(`/api/projects/${p.id}`)).status).toBe(404);
  expect((await member.api.get(`/api/projects/${p.id}/tasks`)).status).toBe(404);
  await member.page.goto(`/projects/${p.id}`);
  await expect(member.page.getByText("This project isn't available").first()).toBeVisible();
  await expect(member.page.getByText(zz("secret row"))).toHaveCount(0);
});

test("AC4: a Done section with more than 10 shows the 10 most recent and Show all reveals the rest", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const p = await proj(admin, "list-done", later);
  for (let i = 1; i <= 12; i++) {
    const id = await mk(admin, p.id, zz(`d${i}`), { dueDate: "2026-11-03" });
    expect((await admin.api.post(`/api/tasks/${id}/complete`, { expectedUpdatedAt: (await getTask(admin, id)).updatedAt })).status).toBe(200);
  }
  await admin.page.goto(`/projects/${p.id}`);
  const done = admin.page.locator(`section[aria-label^="Done"]`).first();
  await expect(done.locator(".item.click")).toHaveCount(10);
  await done.getByRole("button", { name: "Show all 12" }).click();
  await expect(done.locator(".item.click")).toHaveCount(12);
  await expect(done.getByRole("button", { name: /Collapse to the 10 most recent/ })).toBeVisible();
});

test("AC5: an archived project shows its list read-only", async ({ admin, later }) => {
  const p = await proj(admin, "list-archived", later);
  await mk(admin, p.id, zz("kept"), { dueDate: "2026-11-03" });
  expect((await admin.api.post(`/api/projects/${p.id}/archive`)).status).toBe(200);
  expect((await admin.api.post(`/api/projects/${p.id}/tasks`, { dueDate: "2026-11-03", title: zz("late") })).status).toBe(409);
  await admin.page.goto(`/projects/${p.id}`);
  await expect(admin.page.getByText("This project is archived and read-only.")).toBeVisible();
  await expect(admin.page.getByText(zz("kept")).first()).toBeVisible();
  await expect(admin.page.getByRole("button", { name: "+ Add task" })).toHaveCount(0);
});
