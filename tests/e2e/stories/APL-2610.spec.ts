// SHO-BUG-3 Changing the done section (or deleting a section into it) completes parent tasks and leaves their subtasks open  (Linear APL-2610)
// The issue has no numbered acceptance criteria; the checks below follow its "Expected" and "Test" paragraphs.
import { test, expect, zz } from "../support";

async function setup(admin: any, later: (f: () => Promise<unknown>) => void) {
  const pr = await admin.api.post("/api/projects", { name: zz("sections"), leaderId: admin.user.id });
  expect(pr.status).toBe(201);
  const id = pr.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  const sections = (await admin.api.get(`/api/projects/${id}`)).json.project.sections as { id: string; name: string; isDone: boolean }[];
  const open = sections.find((s) => !s.isDone && s.name !== sections[0].name) ?? sections[1];
  const originalDone = sections.find((s) => s.isDone)!;
  const parent = (await admin.api.post(`/api/projects/${id}/tasks`, { title: zz("parent"), sectionId: open.id })).json.task.id as string;
  const subs: string[] = [];
  for (const n of ["sub one", "sub two"]) {
    const r = await admin.api.post(`/api/projects/${id}/tasks`, { title: zz(n), parentId: parent });
    expect(r.status).toBe(201);
    subs.push(r.json.task.id);
  }
  const state = async (tid: string) => !!(await admin.api.get(`/api/tasks/${tid}`)).json.task.completedAt;
  return { id, sections, open, originalDone, parent, subs, state };
}

const completedRows = async (admin: any, projectId: string) =>
  ((await admin.api.get(`/api/projects/${projectId}/activity`)).json.items as { what: string }[]).filter((i) => /^completed /.test(i.what)).map((i) => i.what);

test("Marking a section as the done section completes the parent AND its open subtasks, with one log row each", async ({ admin, later }) => {
  const s = await setup(admin, later);
  expect(await s.state(s.parent)).toBe(false);
  const r = await admin.api.patch(`/api/projects/${s.id}/sections/${s.open.id}`, { isDone: true });
  expect(r.status).toBe(200);
  expect(await s.state(s.parent)).toBe(true);
  for (const sub of s.subs) expect(await s.state(sub), "subtask closes with its parent").toBe(true);
  const rows = (await completedRows(admin, s.id)).join("\n");
  expect(rows).toContain(zz("parent"));
  expect(rows).toContain(zz("sub one"));
  expect(rows).toContain(zz("sub two"));
});

test("Deleting a section into the done section completes the parent AND its open subtasks", async ({ admin, later }) => {
  const s = await setup(admin, later);
  const r = await admin.api.del(`/api/projects/${s.id}/sections/${s.open.id}?moveTo=${s.originalDone.id}`);
  expect(r.status).toBe(204);
  expect(await s.state(s.parent)).toBe(true);
  for (const sub of s.subs) expect(await s.state(sub)).toBe(true);
  const rows = (await completedRows(admin, s.id)).join("\n");
  expect(rows).toContain(zz("sub one"));
  expect(rows).toContain(zz("sub two"));
});

test("Moving the done flag back reopens the parent and its subtasks", async ({ admin, later }) => {
  // KNOWN DEFECT on main dbfbab2: src/lib/sections.ts reopens parents only (sections.ts "old" branch), so the subtasks stay complete.
  // test.fail() keeps this visible: when the defect is fixed this test starts passing and Playwright reports it, so remove test.fail() then.
  test.fail(true, "BUG-3 reverse direction not fixed: subtasks stay complete when the done flag moves back");
  // The issue's Expected/Test text says "after moving the done flag back, all three are open".
  const s = await setup(admin, later);
  await admin.api.patch(`/api/projects/${s.id}/sections/${s.open.id}`, { isDone: true });
  expect(await s.state(s.parent)).toBe(true);
  const back = await admin.api.patch(`/api/projects/${s.id}/sections/${s.originalDone.id}`, { isDone: true });
  expect(back.status).toBe(200);
  expect(await s.state(s.parent), "parent reopens").toBe(false);
  for (const sub of s.subs) expect(await s.state(sub), "subtask reopens with its parent").toBe(false);
});
