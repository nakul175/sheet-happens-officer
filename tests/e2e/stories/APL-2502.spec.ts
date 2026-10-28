import { trashPurgeBefore } from "../../../src/lib/undoable";
import { archiveProject, postTaskCurrent, removeMember } from "../helpers/migration-2731";
import { test } from "./qa";
// APL-2502 · SHO-US-6.1 Delete a task to Trash
// Acceptance criteria: AC1 delete with subtasks, toast offers Undo; AC2 30-day purge; AC3 Viewer refused;
// AC4 people on the task are notified; AC5 Leader restores to the original Section.
// Data: every project and task is named "ZZ-TEST ..."; projects are archived afterwards.
import { readFileSync } from "node:fs";
import { expect, zz, type Who } from "../support";

async function proj(admin: Who, label: string, later: (f: () => Promise<unknown>) => void) {
  const r = await admin.api.post("/api/projects", { name: zz(label), leaderId: admin.user.id });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.project.id as string;
  later(() => archiveProject(admin.api, id, admin.user.id));
  const s = (await admin.api.get(`/api/projects/${id}`)).json.project.sections as { id: string; isDone: boolean }[];
  return { id, todo: s[0].id, doing: s[1].id };
}
const mk = async (admin: Who, p: string, title: string, extra: Record<string, unknown> = {}) => {
  const r = await admin.api.post(`/api/projects/${p}/tasks`, { dueDate: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10), title, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.task.id as string;
};

test("AC1: deleting a task with subtasks takes both out of the views, lists them in Trash, and the toast offers Undo", async ({ admin, later }) => {
  const p = await proj(admin, "trash-del", later);
  const t = await mk(admin, p.id, zz("parent to delete"));
  const sub = await mk(admin, p.id, zz("its subtask"), { parentId: t });
  await admin.page.goto(`/projects/${p.id}?task=${t}`);
  await admin.page.getByRole("button", { name: "Move to Trash" }).click();
  await admin.page.getByRole("button", { name: "Move to Trash" }).last().click();
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

test("AC2: an item stays in Trash for 30 days before it is removed (the purge itself runs from the server's cron)", async ({ admin, later }) => {
  const p = await proj(admin, "trash-days", later);
  const t = await mk(admin, p.id, zz("kept 30 days"));
  expect((await admin.api.del(`/api/tasks/${t}`)).status).toBe(204);
  const item = (await admin.api.get(`/api/projects/${p.id}/trash`)).json.items.find((i: { id: string }) => i.id === t);
  expect(item.daysLeft).toBe(30);
  await admin.page.goto(`/projects/${p.id}/trash`);
  await expect(admin.page.getByRole("row", { name: new RegExp(zz("kept 30 days")) })).toContainText("30 days");
});

test("AC2 (purge after day 30): the purge-trash job removes tasks whose deletedAt is 30 days old and writes one audit row", () => {
  const tasks = readFileSync("src/lib/tasks.ts", "utf8");
  const fn = tasks.slice(tasks.indexOf("export async function purgeTrash"), tasks.indexOf("// ---------------------------------------------------------------- My tasks"));
  const now = new Date("2026-10-29T00:00:00Z");
  expect(trashPurgeBefore(now).getTime()).toBe(now.getTime() - 30 * 86400_000);
  expect(fn).toContain("deletedAt: { lt: trashPurgeBefore(now) }");
  expect(fn).toContain('event: "TASK_PURGED"');
  const jobs = readFileSync("src/lib/jobs.ts", "utf8");
  expect(jobs).toContain('name: "purge-trash"');
  expect(jobs).toContain("purgeTrash()");
});

test("AC3: a Viewer cannot delete", async ({ admin, member, later }) => {
  const p = await proj(admin, "trash-viewer", later);
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: member.user.id, role: "VIEWER" })).status).toBe(201);
  later(() => removeMember(admin, p.id, member.user.id));
  const t = await mk(admin, p.id, zz("viewer cannot"));
  expect((await member.api.del(`/api/tasks/${t}`)).status).toBe(403);
  await member.page.goto(`/projects/${p.id}?task=${t}`);
  await expect(member.page.getByRole("dialog", { name: "Task" }).getByLabel("Title")).toBeVisible();
  await expect(member.page.getByRole("button", { name: "Move to Trash" })).toHaveCount(0);
  expect((await admin.api.get(`/api/tasks/${t}`)).status).toBe(200);
});

test("AC4: when an Editor deletes a task the Leader is told, and the deleter is not", async ({ admin, member, later }) => {
  const p = await proj(admin, "trash-notify", later);
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => removeMember(admin, p.id, member.user.id));
  const t = await mk(admin, p.id, zz("who is told"), { assigneeId: member.user.id });
  expect((await member.api.del(`/api/tasks/${t}`)).status).toBe(204);
  const mine = (await admin.api.get("/api/notifications?limit=50")).json.items as { text: string; href: string }[];
  const note = mine.find((n) => n.text.includes(zz("who is told")) && /to Trash/.test(n.text));
  expect(note, "the Leader gets a deletion notice").toBeTruthy();
  expect(note!.href).toBe(`/projects/${p.id}/trash`);
  const theirs = (await member.api.get("/api/notifications?limit=50")).json.items as { text: string }[];
  expect(theirs.some((n) => n.text.includes(zz("who is told")) && /to Trash/.test(n.text))).toBe(false);
});

test("AC5: the Leader restores a task with its subtasks to its original Section; an Editor cannot restore", async ({ admin, member, later }) => {
  const p = await proj(admin, "trash-restore", later);
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  later(() => removeMember(admin, p.id, member.user.id));
  const t = await mk(admin, p.id, zz("restore me"), { sectionId: p.doing });
  const sub = await mk(admin, p.id, zz("restore child"), { parentId: t });
  expect((await member.api.del(`/api/tasks/${t}`)).status).toBe(204);
  expect((await postTaskCurrent(member, t, "restore")).status).toBe(403);
  await admin.page.goto(`/projects/${p.id}/trash`);
  await admin.page.getByRole("row", { name: new RegExp(zz("restore me")) }).getByRole("button", { name: "Restore" }).click();
  await expect(admin.page.getByText("Trash is empty.")).toBeVisible();
  expect((await admin.api.get(`/api/tasks/${t}`)).json.task.sectionId).toBe(p.doing);
  expect((await admin.api.get(`/api/tasks/${sub}`)).status).toBe(200);
});
