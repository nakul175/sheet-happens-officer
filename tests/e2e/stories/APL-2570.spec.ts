import { archiveProject, postTaskCurrent } from "../helpers/migration-2731";
import { test } from "./qa";
// SHO-US-14.11 Bulk actions (APL-2570). Needs the optional Member account for the second person.
import { expect, zz, type Who, type Later } from "../support";

async function proj(admin: Who, member: Who, later: Later, n: number, extra: (i: number) => object = () => ({})) {
  const r = await admin.api.post("/api/projects", { name: zz("bulk"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id as string;
  later(() => archiveProject(admin.api, id, admin.user.id));
  expect((await admin.api.post(`/api/projects/${id}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = await admin.api.post(`/api/projects/${id}/tasks`, { dueDate: new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10), title: `${zz("job")} ${i}`, assigneeId: admin.user.id, ...extra(i) });
    expect(t.status).toBe(201);
    ids.push(t.json.task.id);
  }
  return { id, ids };
}

test("AC1: selecting 5 tasks shows '5 selected' and the four actions", async ({ admin, member, later }) => {
  const { id } = await proj(admin, member, later, 5);
  const p = admin.page;
  await p.goto(`/projects/${id}`);
  for (let i = 0; i < 5; i++) await p.getByRole("checkbox", { name: `Select "${zz("job")} ${i}"` }).check();
  const bar = p.getByRole("region", { name: "Selected tasks" });
  await expect(bar.getByText("5 selected")).toBeVisible();
  for (const b of ["Assign", "Set date", "Move section", "Complete"]) await expect(bar.getByRole("button", { name: b, exact: true })).toBeVisible();
});

test("AC2: assigning 5 tasks to the Member is one request, one notice for them, and one Undo reverses all", async ({ admin, member, later }) => {
  const { id, ids } = await proj(admin, member, later, 5);
  const p = admin.page;
  const count = async () => ((await member.api.get("/api/notifications?limit=200")).json.items as { text: string }[]);
  const before = (await count()).filter((n) => /assigned you 5 tasks/.test(n.text)).length;
  const bulkCalls: string[] = [];
  p.on("request", (r) => { if (/\/tasks\/bulk$/.test(r.url()) && r.method() === "POST") bulkCalls.push(r.url()); });
  await p.goto(`/projects/${id}`);
  for (let i = 0; i < 5; i++) await p.getByRole("checkbox", { name: `Select "${zz("job")} ${i}"` }).check();
  await p.getByRole("button", { name: "Assign", exact: true }).click();
  await p.getByLabel("Assign to").selectOption({ value: member.user.id });
  await p.getByRole("button", { name: "Assign 5" }).click();
  await expect(p.getByText("5 changed")).toBeVisible();
  expect(bulkCalls.length).toBe(1);
  for (const t of ids) expect((await admin.api.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(member.user.id);
  const notes = await count();
  expect(notes.filter((n) => /assigned you 5 tasks/.test(n.text)).length - before).toBe(1); // one notice in total
  expect(notes.filter((n) => n.text.includes(zz("job"))).length).toBe(0); // and none per task
  // one Undo for the whole group
  await p.getByRole("button", { name: /^Undo/ }).first().click();
  await expect.poll(async () => (await admin.api.get(`/api/tasks/${ids[0]}`)).json.task.assignee.id).toBe(admin.user.id);
  for (const t of ids) expect((await admin.api.get(`/api/tasks/${t}`)).json.task.assignee.id).toBe(admin.user.id);
});

test("AC3: tasks the person may not change are skipped and the result says '4 changed, 1 skipped (no permission)'", async ({ admin, member, later }) => {
  const { id, ids } = await proj(admin, member, later, 5, (i) => (i < 4 ? { assigneeId: member.user.id } : { assigneeId: admin.user.id, approverId: member.user.id }));
  expect((await postTaskCurrent(admin, ids[4], "send-for-approval")).status).toBe(200); // the Member now holds it and may only close or send it back
  const r = await member.api.post(`/api/projects/${id}/tasks/bulk`, { taskIds: ids, action: "assign", assigneeId: admin.user.id });
  expect(r.status).toBe(200);
  expect(r.json.changed).toBe(4);
  expect(r.json.message).toBe("4 changed, 1 skipped (no permission)");
  expect(r.json.skipped.map((s: { id: string }) => s.id)).toEqual([ids[4]]);
});

test("AC4: more than 50 selected is refused with a clear message", async ({ admin, member, later }) => {
  const { id, ids } = await proj(admin, member, later, 1);
  const many = [ids[0], ...Array.from({ length: 50 }, (_, i) => `zz-test-fake-${i}`)];
  const r = await admin.api.post(`/api/projects/${id}/tasks/bulk`, { taskIds: many, action: "complete" });
  expect(r.status).toBe(400);
  expect(String(r.json.error)).toMatch(/up to 50 tasks at once/);
  expect((await admin.api.get(`/api/tasks/${ids[0]}`)).json.task.completedAt).toBeNull();
});
