// APL-2502 · SHO-US-6.1 Delete a task to Trash
// Acceptance criteria: AC1 delete with subtasks, toast offers Undo; AC2 30-day purge; AC3 Viewer refused;
// AC4 people on the task are notified; AC5 Leader restores to the original Section.
// Data: every project and task is named "ZZ-TEST ..."; projects are archived afterwards.
import { test, expect, zz, type Who } from "../support";
import { localSql, runLocalJob, sourceOf, sqlId } from "../helpers/local-clock";
import { clickAboveTabBar } from "../helpers/screen-row";

test.beforeAll(() => {
  test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
});

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

// qa:TC missing
test("AC1: deleting a task with subtasks takes both out of the views, lists them in Trash, and the toast offers Undo", async ({ admin, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await proj(admin, "trash-del", later);
  const t = await mk(admin, p.id, zz("parent to delete"));
  const sub = await mk(admin, p.id, zz("its subtask"), { parentId: t });
  await admin.page.goto(`/projects/${p.id}?task=${t}`);
  await clickAboveTabBar(admin.page.getByRole("dialog", { name: "Task" }).getByRole("button", { name: "Move to Trash" }));
  await admin.page.getByRole("dialog", { name: "Move to Trash?" }).getByRole("button", { name: "Move to Trash" }).click();
  const toast = admin.page.getByRole("status").filter({ hasText: "Task deleted" });
  await expect(toast).toBeVisible();
  await expect(toast.getByRole("button", { name: "Undo" })).toBeVisible();
  const list = (await admin.api.get(`/api/projects/${p.id}/tasks`)).json.sections.flatMap((s: { tasks: { id: string }[] }) => s.tasks).map((x: { id: string }) => x.id);
  expect(list).not.toContain(t);
  expect(list).not.toContain(sub);
  expect((await admin.api.get(`/api/tasks/${sub}`)).status).toBe(404);
  await admin.page.goto(`/projects/${p.id}/trash`);
  await expect(admin.page.getByRole("cell", { name: zz("parent to delete") })).toBeVisible();
});

// qa:TC missing
test("AC2: an item stays in Trash for 30 days before it is removed (the purge itself runs from the server's cron)", async ({ admin, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await proj(admin, "trash-days", later);
  const t = await mk(admin, p.id, zz("kept 30 days"));
  expect((await admin.api.del(`/api/tasks/${t}`)).status).toBe(204);
  const item = (await admin.api.get(`/api/projects/${p.id}/trash`)).json.items.find((i: { id: string }) => i.id === t);
  expect(item.daysLeft).toBe(30);
  await admin.page.goto(`/projects/${p.id}/trash`);
  await expect(admin.page.getByRole("row", { name: new RegExp(zz("kept 30 days")) })).toContainText("30 days");
});

// qa:TC missing
test("APL-2502 AC2: purge-trash removes a task that has been in Trash for 30 days and keeps a newer one", async ({ admin, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await proj(admin, "trash-purge", later);
  const fresh = await mk(admin, p.id, zz("still kept"));
  const aged = await mk(admin, p.id, zz("aged out"));
  expect((await admin.api.del(`/api/tasks/${fresh}`)).status).toBe(204);
  expect((await admin.api.del(`/api/tasks/${aged}`)).status).toBe(204);
  const kept = (await admin.api.get(`/api/projects/${p.id}/trash`)).json.items.find((i: { id: string; daysLeft: number }) => i.id === fresh);
  expect(kept.daysLeft).toBe(30);

  // A staging run has no clock and must not write the database. Locally the same job the cron calls is run.
  if (localSql(`UPDATE "Task" SET "deletedAt" = NOW() - INTERVAL '31 days' WHERE id = '${sqlId(aged)}'`)) {
    const before = (await admin.api.get("/api/audit?event=TASK_PURGED")).json.items as { id: string }[];
    const res = await runLocalJob(admin.page.request, "purge-trash");
    expect(res, "the local purge-trash job").toBeTruthy();
    expect(res!.status(), await res!.text()).toBe(200);
    const trash = (await admin.api.get(`/api/projects/${p.id}/trash`)).json.items as { id: string }[];
    expect(trash.some((i) => i.id === aged), "a task in Trash for 31 days is gone").toBe(false);
    expect(trash.some((i) => i.id === fresh), "a task deleted today is kept").toBe(true);
    expect((await admin.api.get(`/api/tasks/${aged}`)).status).toBe(404);
    const after = (await admin.api.get("/api/audit?event=TASK_PURGED")).json.items as { id: string }[];
    expect(after.length, "one audit row for the purge run").toBe(before.length + 1);
  }
});

// qa:TC missing
test("APL-2502 AC2: purge-trash keeps a task for 30 days before it removes it @static", async () => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const body = sourceOf("src/lib/tasks.ts", "export async function purgeTrash", "export async function myTasks");
  expect(body).toContain("const cutoff = new Date(now.getTime() - 30 * 86400_000)");
  expect(body).toContain("deletedAt: { lte: cutoff }");
  expect(body).toContain('event: "TASK_PURGED"');
  expect(sourceOf("src/lib/jobs.ts", "export const JOBS", "const DAILY_GRACE_HOURS")).toContain('name: "purge-trash", about: "Removes tasks that have been in Trash for 30 days"');
});

// qa:TC missing
test("AC3: a Viewer cannot delete", async ({ admin, member, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await proj(admin, "trash-viewer", later);
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p.id}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  const t = await mk(admin, p.id, zz("viewer cannot"));
  expect((await member.api.del(`/api/tasks/${t}`)).status).toBe(403);
  await member.page.goto(`/projects/${p.id}?task=${t}`);
  await expect(member.page.getByRole("dialog", { name: "Task" }).getByLabel("Title")).toBeVisible();
  await expect(member.page.getByRole("button", { name: "Move to Trash" })).toHaveCount(0);
  expect((await admin.api.get(`/api/tasks/${t}`)).status).toBe(200);
});

// qa:TC missing
test("AC4: when an Editor deletes a task the Leader is told, and the deleter is not", async ({ admin, member, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await proj(admin, "trash-notify", later);
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p.id}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  const t = await mk(admin, p.id, zz("who is told"), { assigneeId: member.user.id });
  expect((await member.api.del(`/api/tasks/${t}`)).status).toBe(204);
  const mine = (await admin.api.get("/api/notifications?limit=50")).json.items as { text: string; href: string }[];
  const note = mine.find((n) => n.text.includes(zz("who is told")) && /to Trash/.test(n.text));
  expect(note, "the Leader gets a deletion notice").toBeTruthy();
  expect(note!.href).toBe(`/projects/${p.id}/trash`);
  const theirs = (await member.api.get("/api/notifications?limit=50")).json.items as { text: string }[];
  expect(theirs.some((n) => n.text.includes(zz("who is told")) && /to Trash/.test(n.text))).toBe(false);
});

// qa:TC missing
test("AC5: the Leader restores a task with its subtasks to its original Section; an Editor cannot restore", async ({ admin, member, later }) => {
  test.info().annotations.push({ type: "qa:TC", description: "qa:TC missing" });
  const p = await proj(admin, "trash-restore", later);
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => admin.api.del(`/api/projects/${p.id}/members/${member.user.id}?handoverTo=${admin.user.id}`));
  const t = await mk(admin, p.id, zz("restore me"), { sectionId: p.doing });
  const sub = await mk(admin, p.id, zz("restore child"), { parentId: t });
  expect((await member.api.del(`/api/tasks/${t}`)).status).toBe(204);
  expect((await member.api.post(`/api/tasks/${t}/restore`)).status).toBe(403);
  await admin.page.goto(`/projects/${p.id}/trash`);
  await admin.page.getByRole("row", { name: new RegExp(zz("restore me")) }).getByRole("button", { name: "Restore" }).click();
  await expect(admin.page.getByText("Trash is empty.")).toBeVisible();
  expect((await admin.api.get(`/api/tasks/${t}`)).json.task.sectionId).toBe(p.doing);
  expect((await admin.api.get(`/api/tasks/${sub}`)).status).toBe(200);
});
