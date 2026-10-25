// SHO-US-4.5 Complete and reopen a task (Linear APL-2495).
// The Super Admin acts as Leader; the plain Member (SHO_MEMBER_*) is the Editor/Viewer/assignee. Member tests skip without it.
import { test, expect, zz } from "../support";
import { getTask, newProject, newTask } from "../g2";

test("AC1: completing sets completedAt, moves the task to the Done Section, and it shows as done (tick on the list)", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.5 tick" });
  const title = zz("4.5 tick me");
  const t = await newTask(admin, p.id, { dueDate: "2026-11-03", title });
  await admin.page.goto(`/projects/${p.id}`);
  await admin.page.getByRole("button", { name: `Complete "${title}"` }).click();
  await expect.poll(async () => (await getTask(admin, t)).completedAt).not.toBeNull();
  const got = await getTask(admin, t);
  expect(got.sectionId).toBe(p.done);
  await expect(admin.page.getByRole("button", { name: `Reopen "${title}"` })).toBeVisible();
});

test("AC1: moving a task into the Done Section completes it", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.5 drag" });
  const t = await newTask(admin, p.id, { dueDate: "2026-11-03" });
  expect((await admin.api.post(`/api/tasks/${t}/move`, { sectionId: p.done, expectedUpdatedAt: (await getTask(admin, t)).updatedAt })).status).toBe(200);
  const got = await getTask(admin, t);
  expect(got.completedAt).not.toBeNull();
  expect(got.sectionId).toBe(p.done);
});

test("AC2: reopening clears completedAt and returns the task to the Section it came from, or to the one it is dragged to", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.5 reopen" });
  const t = await newTask(admin, p.id, { dueDate: "2026-11-03", sectionId: p.doing });
  await admin.api.post(`/api/tasks/${t}/complete`, { expectedUpdatedAt: (await getTask(admin, t)).updatedAt });
  expect((await admin.api.post(`/api/tasks/${t}/reopen`)).status).toBe(200);
  let got = await getTask(admin, t);
  expect(got.completedAt).toBeNull();
  expect(got.sectionId).toBe(p.doing); // where it was before completion
  await admin.api.post(`/api/tasks/${t}/move`, { sectionId: p.done, expectedUpdatedAt: (await getTask(admin, t)).updatedAt });
  expect((await admin.api.post(`/api/tasks/${t}/move`, { sectionId: p.todo, expectedUpdatedAt: (await getTask(admin, t)).updatedAt })).status).toBe(200); // dragged out to another Section
  got = await getTask(admin, t);
  expect(got.completedAt).toBeNull();
  expect(got.sectionId).toBe(p.todo);
});

test("AC3: completing a task with open subtasks warns; 'Complete all' closes them with one log row each; no silent completion", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.5 subtasks" });
  const names = [zz("4.5 sub parent"), zz("4.5 sub one"), zz("4.5 sub two")];
  const parent = await newTask(admin, p.id, { dueDate: "2026-11-03", title: names[0], sectionId: p.doing });
  const subs = [await newTask(admin, p.id, { title: names[1], parentId: parent }), await newTask(admin, p.id, { title: names[2], parentId: parent })];
  const warn = await admin.api.post(`/api/tasks/${parent}/complete`, { expectedUpdatedAt: (await getTask(admin, parent)).updatedAt });
  expect(warn.status).toBe(409);
  expect(warn.json.needsConfirm).toBe("open_subtasks");
  expect((await getTask(admin, parent)).completedAt).toBeNull();
  for (const s of subs) expect((await getTask(admin, s)).completedAt).toBeNull(); // nothing completed silently
  expect((await admin.api.post(`/api/tasks/${parent}/complete`, { completeAll: true, expectedUpdatedAt: (await getTask(admin, parent)).updatedAt })).status).toBe(200);
  for (const s of [parent, ...subs]) expect((await getTask(admin, s)).completedAt).not.toBeNull();
  const rows = ((await admin.api.get(`/api/projects/${p.id}/activity`)).json.items as { what: string }[]).map((i) => i.what).filter((w) => /^completed /.test(w));
  for (const n of names) expect(rows.filter((w) => w.includes(n)), `exactly one completed row for "${n}"`).toHaveLength(1); // parent and each subtask
});

test("AC2: when the Section it came from no longer exists, a reopened task returns to the first non-Done Section", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.5 gone section" });
  const t = await newTask(admin, p.id, { dueDate: "2026-11-03", sectionId: p.doing });
  expect((await admin.api.post(`/api/tasks/${t}/complete`, { expectedUpdatedAt: (await getTask(admin, t)).updatedAt })).status).toBe(200);
  expect((await admin.api.del(`/api/projects/${p.id}/sections/${p.doing}?moveTo=${p.todo}`)).status).toBe(204); // the remembered Section goes
  expect((await admin.api.post(`/api/tasks/${t}/reopen`)).status).toBe(200);
  const got = await getTask(admin, t);
  expect(got.completedAt).toBeNull();
  expect(got.sectionId, "the first non-Done Section").toBe(p.todo);
});

test("AC3: the tick on a task with open subtasks asks 'Complete them all' or Cancel (screen)", async ({ admin, later }) => {
  const p = await newProject(admin, later, { label: "4.5 ask" });
  const title = zz("4.5 parent");
  const parent = await newTask(admin, p.id, { dueDate: "2026-11-03", title });
  await newTask(admin, p.id, { parentId: parent });
  await admin.page.goto(`/projects/${p.id}`);
  await admin.page.getByRole("button", { name: `Complete "${title}"` }).click();
  const dlg = admin.page.getByRole("dialog");
  await expect(dlg).toContainText("1 open subtask");
  await dlg.getByRole("button", { name: "Cancel" }).click();
  expect((await getTask(admin, parent)).completedAt).toBeNull();
});

test("AC4: a Viewer, or an archived project, cannot complete or reopen", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.5 viewer", members: [{ who: member, role: "VIEWER" }] });
  const t = await newTask(admin, p.id, { dueDate: "2026-11-03" });
  const done = await newTask(admin, p.id, { dueDate: "2026-11-03" });
  await admin.api.post(`/api/tasks/${done}/complete`, { expectedUpdatedAt: (await getTask(admin, done)).updatedAt });
  expect((await member.api.post(`/api/tasks/${t}/complete`, { expectedUpdatedAt: (await getTask(member, t)).updatedAt })).status).toBe(403);
  expect((await member.api.post(`/api/tasks/${done}/reopen`)).status).toBe(403);
  await admin.api.post(`/api/projects/${p.id}/archive`);
  expect((await admin.api.post(`/api/tasks/${t}/complete`, { expectedUpdatedAt: (await getTask(admin, t)).updatedAt })).status).toBe(409);
  expect((await admin.api.post(`/api/tasks/${done}/reopen`)).status).toBe(409);
});

test("AC4: with an approver, a person who may not close it gets no usable tick and is refused moving it to Done", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.5 approver", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("4.5 needs approval");
  const t = await newTask(admin, p.id, { dueDate: "2026-11-03", title, assigneeId: member.user.id, approverId: admin.user.id });
  expect((await member.api.post(`/api/tasks/${t}/complete`, { expectedUpdatedAt: (await getTask(member, t)).updatedAt })).status).toBe(403);
  expect((await member.api.post(`/api/tasks/${t}/move`, { sectionId: p.done, expectedUpdatedAt: (await getTask(member, t)).updatedAt })).status).toBe(403);
  await member.page.goto(`/projects/${p.id}`);
  const tick = member.page.getByRole("button", { name: `"${title}" can only be closed by its approver` });
  await expect(tick).toBeVisible();
  await expect(tick).toBeDisabled();
  expect((await getTask(admin, t)).completedAt).toBeNull();
});
