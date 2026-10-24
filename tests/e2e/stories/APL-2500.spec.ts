// APL-2500 · SHO-US-5.5 Task detail overlay
// Acceptance criteria: AC1 fields and Close returns to the same scroll position, AC2 role (Viewer read-only),
// AC3 concierge stays usable, AC4 task link and "This task isn't available", AC5 stale save warning.
// Data: every project and task is named "ZZ-TEST ..."; projects are archived afterwards.
import { test, expect, zz, type Who, type Page } from "../support";
import { getTask } from "../g2";

const ist = (d: number) => new Date(Date.now() + 5.5 * 3600e3 + d * 864e5).toISOString().slice(0, 10);

async function proj(admin: Who, label: string, later: (f: () => Promise<unknown>) => void) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  return id;
}
const mk = async (admin: Who, p: string, title: string, extra: Record<string, unknown> = {}) => {
  const r = await admin.api.post(`/api/projects/${p}/tasks`, { title, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
};
const dialog = (page: Page) => page.getByRole("dialog", { name: "Task" });

test("AC1: opening a task shows all its fields, and Close returns to the same scroll position", async ({ admin, later }) => {
  test.setTimeout(120_000);
  const p = await proj(admin, "ov-fields", later);
  const sub = await mk(admin, p, zz("parent"), { description: "Some details", dueDate: ist(3), priority: "HIGH" });
  await admin.api.post(`/api/projects/${p}/tasks`, { title: zz("child"), parentId: sub });
  for (let i = 0; i < 30; i++) await mk(admin, p, zz(`filler ${String(i).padStart(2, "0")}`), { dueDate: ist(10 + i) });
  await admin.page.goto(`/projects/${p}`);
  await admin.page.locator(".item.click").first().waitFor();
  // scroll down the list, open a row near the bottom, close, and compare
  const target = admin.page.locator(".item.click", { hasText: zz("filler 25") });
  await target.scrollIntoViewIfNeeded();
  const pos = () => admin.page.evaluate(() => Math.round(window.scrollY + ((document.querySelector(".content") as HTMLElement | null)?.scrollTop as number)));
  const before = await pos();
  expect(before).toBeGreaterThan(300);
  await target.click();
  await expect(dialog(admin.page)).toBeVisible();
  await admin.page.getByRole("button", { name: "Close" }).click();
  await expect(dialog(admin.page)).toHaveCount(0);
  expect(Math.abs((await pos()) - before)).toBeLessThanOrEqual(5);
  // the fields
  await admin.page.goto(`/projects/${p}?task=${sub}`);
  const d = dialog(admin.page);
  await expect(d.getByLabel("Title")).toHaveValue(zz("parent"));
  for (const l of ["Assignee", "Due date", "Section", "Priority"]) await expect(d.getByLabel(l, { exact: true })).toBeVisible();
  await expect(d.getByText("Approver", { exact: true })).toBeVisible(); // a control only when someone else is the assignee
  await expect(d.getByLabel("Due date")).toHaveValue(ist(3));
  await expect(d.locator("textarea#desc")).toHaveValue("Some details");
  await expect(d.getByText(zz("child"))).toBeVisible(); // subtask checklist
  await expect(d.getByRole("button", { name: "Move to Trash" })).toBeVisible();
});

test("AC2: a Viewer sees every field read-only and no action buttons; the Leader can edit", async ({ admin, member, later }) => {
  const p = await proj(admin, "ov-role", later);
  expect((await admin.api.post(`/api/projects/${p}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  const t = await mk(admin, p, zz("role task"));
  await member.page.goto(`/projects/${p}?task=${t}`);
  const v = dialog(member.page);
  await expect(v.getByLabel("Title")).toHaveJSProperty("readOnly", true);
  await expect(v.locator("textarea#desc")).toHaveJSProperty("readOnly", true);
  await expect(v.getByLabel("Assignee", { exact: true })).toHaveCount(0); // shown as text, not a control
  for (const b of ["Mark complete", "Close task", "Send for approval", "Move to Trash", "Reopen"]) await expect(v.getByRole("button", { name: b })).toHaveCount(0);
  await admin.page.goto(`/projects/${p}?task=${t}`);
  const l = dialog(admin.page);
  await expect(l.getByLabel("Title")).toHaveJSProperty("readOnly", false);
  await expect(l.getByLabel("Assignee", { exact: true })).toBeEnabled();
  await expect(l.getByRole("button", { name: "Mark complete" })).toBeVisible();
});

test("AC3: the concierge stays visible while the overlay is open", async ({ admin, later }) => {
  const p = await proj(admin, "ov-concierge", later);
  const t = await mk(admin, p, zz("concierge task"));
  await admin.page.goto(`/projects/${p}?task=${t}`);
  await expect(dialog(admin.page)).toBeVisible();
  const c = admin.page.locator('aside[aria-label="Concierge"]');
  await expect(c).toBeVisible();
  const box = await c.boundingBox();
  expect(box && box.width > 0 && box.height > 0).toBe(true);
});

test("AC4: a task link opens the task over its project; a trashed, missing or foreign task says it isn't available", async ({ admin, member, later }) => {
  const p = await proj(admin, "ov-link", later);
  const t = await mk(admin, p, zz("linked"));
  await admin.page.goto(`/tasks/${t}`);
  // APL-2652 preserves the task URL when return-to is enabled; the legacy mode opens the project overlay.
  const stay = await admin.page.evaluate(() => (window as Window & { __SHO_RETURN_TO?: number }).__SHO_RETURN_TO === 1);
  await expect(admin.page).toHaveURL(new RegExp(stay ? `/tasks/${t}$` : `/projects/${p}\\?task=${t}$`));
  await expect(admin.page.getByLabel("Title", { exact: true })).toHaveValue(zz("linked"));
  await expect(admin.page.getByRole("button", { name: "Copy link" })).toBeVisible();
  // not a member
  await member.page.goto(`/tasks/${t}`);
  await expect(member.page.getByRole("heading", { name: "This task isn't available", exact: true })).toBeVisible();
  await expect(member.page.getByText(zz("linked"))).toHaveCount(0);
  // in Trash
  expect((await admin.api.del(`/api/tasks/${t}`)).status).toBe(204);
  await admin.page.goto(`/tasks/${t}`);
  await expect(admin.page.getByRole("heading", { name: "This task isn't available", exact: true })).toBeVisible();
  await expect(admin.page.getByText(zz("linked"))).toHaveCount(0);
  // does not exist
  await admin.page.goto(`/tasks/zz-test-does-not-exist`);
  await expect(admin.page.getByRole("heading", { name: "This task isn't available", exact: true })).toBeVisible();
});

test("AC5: saving over someone else's change shows the warning and offers to re-apply the edit", async ({ admin, later }) => {
  const p = await proj(admin, "ov-stale", later);
  const t = await mk(admin, p, zz("stale"));
  await admin.page.goto(`/projects/${p}?task=${t}`);
  const d = dialog(admin.page);
  await expect(d.getByLabel("Title")).toHaveValue(zz("stale"));
  // someone else changes the task after the overlay opened (a second client, same account is enough to move updatedAt)
  expect((await admin.api.patch(`/api/tasks/${t}`, { priority: "HIGH", expectedUpdatedAt: (await getTask(admin, t)).updatedAt })).status).toBe(200);
  await d.getByLabel("Title").fill(zz("stale edited"));
  await d.getByLabel("Title").press("Enter");
  const warn = d.getByRole("alert").filter({ hasText: "changed this task while you were editing" });
  await expect(warn).toBeVisible();
  await expect(warn.getByRole("button", { name: "Re-apply my edit" })).toBeVisible();
  await warn.getByRole("button", { name: "Re-apply my edit" }).click();
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${t}`)).json.task.title).toBe(zz("stale edited"));
});
