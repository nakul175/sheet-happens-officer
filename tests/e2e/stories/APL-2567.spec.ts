// SHO-US-14.8 Inline editing in lists (Linear APL-2567).
// Choosing a different assignee needs a second worker in the project, so most checks use the Member account.
import { test, expect, zz, type Json } from "../support";

type Who = { api: import("../support").Api; user: Json; page: import("@playwright/test").Page };
type Later = (f: () => Promise<unknown>) => void;

async function setup(admin: Who, member: Who, later: Later, label: string, role: "EDITOR" | "VIEWER" = "EDITOR") {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const pid = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${pid}/archive`));
  expect((await admin.api.post(`/api/projects/${pid}/members`, { userId: member.user.id, role })).status).toBe(201);
  const mk = async (title: string, extra: Record<string, unknown> = {}) => {
    const t = await admin.api.post(`/api/projects/${pid}/tasks`, { title, assigneeId: admin.user.id, ...extra });
    expect(t.status).toBe(201);
    later(() => admin.api.del(`/api/tasks/${t.json.task.id}`));
    return t.json.task.id as string;
  };
  return { pid, mk };
}
const row = (page: import("@playwright/test").Page, title: string) => page.getByRole("main").getByRole("link").filter({ hasText: title }).first();
const IST = (n: number) => new Date(Date.now() + 5.5 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
const getTask = async (who: Who, id: string) => (await who.api.get(`/api/tasks/${id}`)).json.task;

test("AC1: clicking the assignee cell opens a person picker; choosing saves in one action with a toast and Undo", async ({ admin, member, later }) => {
  const s = await setup(admin, member, later, "14.8 who");
  const title = zz("14.8 assign");
  const tid = await s.mk(title);
  const page = admin.page;
  await page.goto(`/projects/${s.pid}`);
  await row(page, title).getByRole("button", { name: /^Assignee .*Change$/ }).click();
  const picker = page.getByRole("dialog", { name: "Choose assignee" });
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: member.user.name, exact: true }).click();
  // The toast is the status region that offers Undo; the concierge's "not switched on yet" notice is a status too.
  const toast = page.getByRole("status").filter({ has: page.getByRole("button", { name: "Undo" }) });
  await expect(toast).toContainText("Undo");
  await expect(async () => { expect((await getTask(admin, tid)).assignee.id).toBe(member.user.id); }).toPass({ timeout: 8000 });
  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(async () => { expect((await getTask(admin, tid)).assignee.id).toBe(admin.user.id); }).toPass({ timeout: 8000 });
});

test("AC2: clicking the date cell opens a picker with Today, Tomorrow and Next week buttons", async ({ admin, member, later }) => {
  const s = await setup(admin, member, later, "14.8 date");
  const title = zz("14.8 date");
  const tid = await s.mk(title);
  const page = admin.page;
  await page.goto(`/projects/${s.pid}`);
  await row(page, title).getByRole("button", { name: /^Due date .*Change$/ }).click();
  const picker = page.getByRole("dialog", { name: "Choose due date" });
  for (const b of ["Today", "Tomorrow", "Next week"]) await expect(picker.getByRole("button", { name: b })).toBeVisible();
  await picker.getByRole("button", { name: "Tomorrow" }).click();
  await expect(page.getByRole("status").filter({ has: page.getByRole("button", { name: "Undo" }) })).toContainText("Undo");
  await expect(async () => { expect((await getTask(admin, tid)).dueDate).toBe(IST(1)); }).toPass({ timeout: 8000 });
  await row(page, title).getByRole("button", { name: /^Due date .*Change$/ }).click();
  await page.getByRole("dialog", { name: "Choose due date" }).getByRole("button", { name: "Next week" }).click();
  await expect(async () => { expect((await getTask(admin, tid)).dueDate).toBe(IST(7)); }).toPass({ timeout: 8000 });
});

test("AC3: cells are read-only for a Viewer", async ({ admin, member, later }) => {
  const s = await setup(admin, member, later, "14.8 viewer", "VIEWER");
  const title = zz("14.8 viewer task");
  await s.mk(title);
  const page = member.page;
  await page.goto(`/projects/${s.pid}`);
  await expect(row(page, title)).toBeVisible();
  await expect(row(page, title).getByRole("button", { name: /Change$/ })).toHaveCount(0);
});

test("AC3 (awaiting approval): cells are read-only for an Editor who is not the holder", async ({ admin, member, later }) => {
  const s = await setup(admin, member, later, "14.8 held");
  const title = zz("14.8 held task");
  const tid = await s.mk(title, { assigneeId: member.user.id, approverId: admin.user.id });
  // Control: while the task is with the Member, the Member can edit it in place.
  const page = member.page;
  await page.goto(`/projects/${s.pid}`);
  await expect(row(page, title).getByRole("button", { name: /Change$/ }).first()).toBeVisible();
  // After the Member sends it for approval it is held by the Leader, and the Member's cells turn read-only.
  expect((await member.api.post(`/api/tasks/${tid}/send-for-approval`)).status).toBe(200);
  await page.goto(`/projects/${s.pid}`);
  await expect(row(page, title)).toBeVisible();
  await expect(row(page, title).getByRole("button", { name: /Change$/ })).toHaveCount(0);
  // The Leader who holds it still edits in place.
  await admin.page.goto(`/projects/${s.pid}`);
  await expect(row(admin.page, title).getByRole("button", { name: /Change$/ }).first()).toBeVisible();
});

test("AC4: an edit to a task that changed elsewhere shows the stale-edit message and offers to re-apply", async ({ admin, member, later }) => {
  const s = await setup(admin, member, later, "14.8 stale");
  const title = zz("14.8 stale");
  const tid = await s.mk(title);
  const page = admin.page;
  await page.goto(`/projects/${s.pid}`);
  await expect(row(page, title)).toBeVisible();
  // Somebody else (here: the API as the same account) changes the task after the page loaded.
  expect((await admin.api.patch(`/api/tasks/${tid}`, { priority: "LOW", expectedUpdatedAt: (await admin.api.get(`/api/tasks/${tid}`)).json.task.updatedAt })).status).toBe(200);
  await row(page, title).getByRole("button", { name: /^Priority .*Change$/ }).click();
  await page.getByRole("dialog", { name: "Choose priority" }).getByRole("button", { name: "Urgent" }).click();
  const note = page.getByRole("alert").filter({ hasText: "while you were editing" });
  await expect(note).toBeVisible();
  await expect(note).toContainText("Your change was not saved");
  expect((await getTask(admin, tid)).priority).toBe("LOW"); // nothing was overwritten
  await note.getByRole("button", { name: "Re-apply my edit" }).click();
  await expect(async () => { expect((await getTask(admin, tid)).priority).toBe("URGENT"); }).toPass({ timeout: 8000 });
});

test("AC5: with focus on a row, each cell is reachable and editable by keyboard", async ({ admin, member, later }) => {
  const s = await setup(admin, member, later, "14.8 keys");
  const title = zz("14.8 keys");
  const tid = await s.mk(title);
  const page = admin.page;
  await page.goto(`/projects/${s.pid}`);
  const r = row(page, title);
  await expect(r).toBeVisible();
  await r.focus();
  const seen: string[] = [];
  for (let i = 0; i < 12 && seen.length < 3; i++) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => { const a = document.activeElement as HTMLElement; return a?.classList.contains("ic-cell") ? a.getAttribute("aria-label") : null; });
    if (label) seen.push(label);
  }
  expect(seen.map((l) => l.split(" ")[0])).toEqual(["Assignee", "Priority", "Due"]);
  // Edit the priority with the keyboard only: open with Enter, move with the arrow keys, choose with Enter.
  await page.keyboard.press("Shift+Tab"); // back from Due to Priority
  await expect(page.getByRole("button", { name: /^Priority .*Change$/ })).toBeFocused();
  await page.keyboard.press("Enter");
  const picker = page.getByRole("dialog", { name: "Choose priority" });
  await expect(picker).toBeVisible();
  await page.keyboard.press("ArrowDown"); // Urgent -> High
  await page.keyboard.press("Enter");
  await expect(async () => { expect((await getTask(admin, tid)).priority).toBe("HIGH"); }).toPass({ timeout: 8000 });
  // Escape closes a picker and puts focus back on its cell.
  await row(page, title).getByRole("button", { name: /^Priority .*Change$/ }).focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Priority .*Change$/ })).toBeFocused();
});
