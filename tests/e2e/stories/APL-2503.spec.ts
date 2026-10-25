// APL-2503 · SHO-US-6.2 Restore from Trash
// Acceptance criteria: AC1 restore with subtasks to the old Section; AC2 parent also in Trash asks to Restore both;
// AC3 deactivated assignee falls back to the Leader; AC4 Editor and Viewer see the list but cannot restore; AC5 list columns.
// Data: every project and task is named "ZZ-TEST ..."; the one person AC3 creates is named "ZZ-TEST ..." with an address at
// example.invalid (no real inbox) and is deactivated afterwards. Projects are archived afterwards.
import { test, expect, zz, RUN, type Who } from "../support";
import { randomUUID } from "node:crypto";

async function proj(admin: Who, label: string, later: (f: () => Promise<unknown>) => void) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  const s = (await admin.api.get(`/api/projects/${id}`)).json.project.sections as { id: string; isDone: boolean }[];
  return { id, todo: s[0].id, doing: s[1].id };
}
const mk = async (admin: Who, p: string, title: string, extra: Record<string, unknown> = {}) => {
  const r = await admin.api.post(`/api/projects/${p}/tasks`, { title, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
};

test("AC1: restoring returns the task with its subtasks to its old Section and order", async ({ admin, later }) => {
  const p = await proj(admin, "restore-basic", later);
  const first = await mk(admin, p.id, zz("first"), { sectionId: p.doing, dueDate: "2030-01-01" });
  const t = await mk(admin, p.id, zz("middle"), { sectionId: p.doing, dueDate: "2030-02-01" });
  const last = await mk(admin, p.id, zz("last"), { sectionId: p.doing, dueDate: "2030-03-01" });
  const sub = await mk(admin, p.id, zz("middle child"), { parentId: t });
  expect((await admin.api.del(`/api/tasks/${t}`)).status).toBe(204);
  expect((await admin.api.post(`/api/tasks/${t}/restore`)).status).toBe(200);
  const sec = (await admin.api.get(`/api/projects/${p.id}/tasks?sectionId=${p.doing}`)).json.sections[0].tasks.map((x: { id: string }) => x.id);
  expect(sec).toEqual([first, t, last]);
  expect((await admin.api.get(`/api/tasks/${sub}`)).status).toBe(200);
});

test("AC2: restoring a subtask whose parent is also in Trash asks to restore both, and both return on confirm", async ({ admin, later }) => {
  const p = await proj(admin, "restore-parent", later);
  const parent = await mk(admin, p.id, zz("the parent"), { dueDate: "2026-11-03" });
  const child = await mk(admin, p.id, zz("the child"), { parentId: parent });
  expect((await admin.api.del(`/api/tasks/${child}`)).status).toBe(204); // deleted on its own first, so it is listed
  expect((await admin.api.del(`/api/tasks/${parent}`)).status).toBe(204);
  await admin.page.goto(`/projects/${p.id}/trash`);
  await admin.page.getByRole("row", { name: new RegExp(zz("the child")) }).getByRole("button", { name: "Restore" }).click();
  const ask = admin.page.getByRole("dialog");
  await expect(ask).toContainText(`The parent task "${zz("the parent")}" is also in Trash`);
  await ask.getByRole("button", { name: "Restore both" }).click();
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${parent}`)).status).toBe(200);
  expect((await admin.api.get(`/api/tasks/${child}`)).status).toBe(200);
});

test("AC3: when the assignee has been deactivated, the restored task goes to the Leader", async ({ admin, later }) => {
  const p = await proj(admin, "restore-gone", later);
  // This fixture is deactivated, not deleted: use an invocation-specific email even when a worker reuses RUN.
  const email = `zz-test-2503-${randomUUID()}@example.invalid`;
  const add = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `leaver ${RUN}`, email, role: "MEMBER" });
  expect(add.status, JSON.stringify(add.json)).toBe(201);
  const id = (add.json.person?.id ?? add.json.user?.id ?? add.json.id) as string;
  expect(id).toBeTruthy();
  later(() => admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }));
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: id, role: "EDITOR" })).status).toBe(201);
  const t = await mk(admin, p.id, zz("orphan"), { dueDate: "2026-11-03", assigneeId: id });
  const sub = await mk(admin, p.id, zz("orphan child"), { parentId: t, assigneeId: id });
  expect((await admin.api.del(`/api/tasks/${t}`)).status).toBe(204);
  expect((await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
  expect((await admin.api.post(`/api/tasks/${t}/restore`)).status).toBe(200);
  expect((await admin.api.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(admin.user.id);
  expect((await admin.api.get(`/api/tasks/${sub}`)).json.task.assignee.id).toBe(admin.user.id);
});

test("AC4: an Editor and a Viewer can see the Trash list but Restore is refused", async ({ admin, member, later }) => {
  const p = await proj(admin, "restore-roles", later);
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p.id}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  const t = await mk(admin, p.id, zz("seen not restored"), { dueDate: "2026-11-03" });
  expect((await admin.api.del(`/api/tasks/${t}`)).status).toBe(204);
  for (const role of ["EDITOR", "VIEWER"]) {
    if (role === "VIEWER") expect((await admin.api.patch(`/api/projects/${p.id}/members/${member.user.id}`, { role })).status).toBe(200);
    await member.page.goto(`/projects/${p.id}/trash`);
    await expect(member.page.getByRole("cell", { name: zz("seen not restored") })).toBeVisible();
    await expect(member.page.getByRole("button", { name: "Restore" })).toHaveCount(0);
    expect((await member.api.post(`/api/tasks/${t}/restore`)).status, role).toBe(403);
  }
});

test("AC5: each Trash row shows the task, who deleted it, when, and the days left", async ({ admin, later }) => {
  const p = await proj(admin, "restore-list", later);
  const t = await mk(admin, p.id, zz("listed"), { dueDate: "2026-11-03" });
  expect((await admin.api.del(`/api/tasks/${t}`)).status).toBe(204);
  await admin.page.goto(`/projects/${p.id}/trash`);
  await expect(admin.page.getByRole("columnheader")).toContainText(["Item", "Deleted by", "Deleted", "Time left"]);
  const row = admin.page.getByRole("row", { name: new RegExp(zz("listed")) });
  await expect(row).toContainText(admin.user.name);
  await expect(row).toContainText("30 days");
  await expect(row.locator("td").nth(2)).not.toBeEmpty();
});
