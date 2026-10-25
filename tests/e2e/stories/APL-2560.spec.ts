// SHO-US-14.1 Approval state stays truthful (Linear APL-2560).
// Needs a second person (the Member account) because a task awaits approval only when it sits with a different person than its assignee.
import { test, expect, zz, type Json } from "../support";

type Who = { api: import("../support").Api; user: Json };

/** A ZZ-TEST project led by the admin, the member as Editor, and a task for the member with the admin as approver. */
async function setup(admin: Who, member: Who, later: (f: () => Promise<unknown>) => void, label: string) {
  const p = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(p.status).toBe(201);
  const pid = p.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${pid}/archive`));
  expect((await admin.api.post(`/api/projects/${pid}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const t = await admin.api.post(`/api/projects/${pid}/tasks`, { dueDate: "2031-03-20", title: zz(`${label} task`), assigneeId: member.user.id, approverId: admin.user.id });
  expect(t.status).toBe(201);
  const tid = t.json.task.id as string;
  later(() => admin.api.del(`/api/tasks/${tid}`));
  // The member sends it for approval: it now sits with the admin and awaits approval.
  expect((await member.api.post(`/api/tasks/${tid}/send-for-approval`)).status).toBe(200);
  return { pid, tid, title: zz(`${label} task`) };
}

test("AC1: closing an approval shows Done, drops the waiting banner and offers Reopen within 1 second", async ({ admin, member, later }) => {
  const s = await setup(admin, member, later, "14.1 close");
  const page = admin.page;
  await page.goto(`/projects/${s.pid}?task=${s.tid}`);
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog.getByText(/Waiting for/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close task" })).toBeVisible();
  const started = Date.now();
  await dialog.getByRole("button", { name: "Close task" }).click();
  await expect(dialog.getByRole("button", { name: "Reopen" })).toBeVisible({ timeout: 1000 });
  await expect(dialog.getByText(/Waiting for/)).toHaveCount(0);
  expect(Date.now() - started).toBeLessThan(1500); // 1 second plus a click's own time
});

test("AC2: a closed task shows no Awaiting chip on the list or the board", async ({ admin, member, later }) => {
  const s = await setup(admin, member, later, "14.1 chips");
  const page = admin.page;
  await page.goto(`/projects/${s.pid}`);
  const row = page.locator("main .item", { hasText: s.title }).last();
  await expect(row.getByText("Awaiting approval")).toBeVisible(); // control: it is awaiting before the close
  expect((await admin.api.post(`/api/tasks/${s.tid}/complete`, { expectedUpdatedAt: (await admin.api.get(`/api/tasks/${s.tid}`)).json.task.updatedAt })).status).toBe(200);
  await page.goto(`/projects/${s.pid}`);
  await expect(page.locator("main .item", { hasText: s.title }).last()).toBeVisible();
  await expect(page.locator("main .item", { hasText: s.title }).last().getByText(/Awaiting/)).toHaveCount(0);
  await page.goto(`/projects/${s.pid}?view=board`);
  const card = page.locator(".bcard", { hasText: s.title }).last();
  await expect(card).toBeVisible();
  await expect(card.getByText(/Awaiting/)).toHaveCount(0);
});

test("AC3: sending back clears the banner and the chip and shows the new holder", async ({ admin, member, later }) => {
  const s = await setup(admin, member, later, "14.1 back");
  const page = admin.page;
  await page.goto(`/projects/${s.pid}?task=${s.tid}`);
  const dialog = page.getByRole("dialog", { name: "Task" });
  await expect(dialog.getByText(/Waiting for/)).toBeVisible();
  await dialog.getByRole("button", { name: "Send back" }).click();
  await expect(dialog.getByText(/Waiting for/)).toHaveCount(0);
  await expect(dialog.getByLabel("Assignee", { exact: true })).toHaveValue(member.user.id); // the new holder is the person it went back to
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("main .item", { hasText: s.title }).last().getByText(/Awaiting/)).toHaveCount(0);
});

test("AC4: when the close request fails the panel keeps the old state and shows an error", async ({ admin, member, later }) => {
  const s = await setup(admin, member, later, "14.1 fail");
  const page = admin.page;
  await page.route(`**/api/tasks/${s.tid}/complete`, (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Something went wrong." }) }));
  await page.goto(`/projects/${s.pid}?task=${s.tid}`);
  const dialog = page.getByRole("dialog", { name: "Task" });
  await dialog.getByRole("button", { name: "Close task" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(dialog.getByText(/Waiting for/)).toBeVisible(); // still the old state: nothing the server did not confirm
  await expect(dialog.getByRole("button", { name: "Reopen" })).toHaveCount(0);
  // And the server agrees: the task is still open.
  const t = await admin.api.get(`/api/tasks/${s.tid}`);
  expect(t.json.task.completedAt).toBeNull();
});
