// Playwright story for SHO-US-4.6. APL-2522.spec.ts is the Vitest spec and is not run here.
// SHO-US-4.6 Optional approver on a task (Linear APL-2522).
// The Super Admin acts as Leader/Admin; the plain Member (SHO_MEMBER_*) is the Editor who does the work. A ZZ-TEST person who cannot sign in
// (a reserved .invalid address) stands in as the second Editor / approver. Tests that need the Member skip without SHO_MEMBER_*.
import { test, expect, zz } from "../support";
import { ghost, getTask, newProject, newTask, type Who } from "../g2";

/** Project with the Member as Editor and a ZZ-TEST person as a second Editor (the approver). */
async function setup(admin: Who, member: Who, later: (fn: () => Promise<unknown>) => void, label: string) {
  const p = await newProject(admin, later, { label, members: [{ who: member, role: "EDITOR" }] });
  const boss = await ghost(admin, later, "approver");
  expect((await admin.api.post(`/api/projects/${p.id}/members`, { userId: boss.id, role: "EDITOR" })).status).toBe(201);
  const t = await newTask(member, p.id, { title: zz(`${label} task`) });
  return { p, boss, t };
}

test("AC1: the Leader names an approver (Leader or Editor, not the assignee); a Viewer, non-member, deactivated person or the assignee is refused; the assignee cannot set it", async ({ admin, member, later }) => {
  const { p, boss, t } = await setup(admin, member, later, "4.6 ac1");
  const viewer = await ghost(admin, later, "viewer");
  const outsider = await ghost(admin, later, "outsider");
  const gone = await ghost(admin, later, "gone");
  await admin.api.post(`/api/projects/${p.id}/members`, { userId: viewer.id, role: "VIEWER" });
  await admin.api.post(`/api/projects/${p.id}/members`, { userId: gone.id, role: "EDITOR" });
  await admin.api.post(`/api/team/${gone.id}/deactivate`, { reassign: "leaders" });
  const put = (who: Who, id: string | null) => who.api.put(`/api/tasks/${t}/approver`, { approverId: id });
  expect((await put(member, boss.id)).status).toBe(403); // the assignee
  expect((await put(admin, member.user.id)).status).toBe(400); // is the assignee
  expect((await put(admin, viewer.id)).status).toBe(400);
  expect((await put(admin, outsider.id)).status).toBe(400);
  expect((await put(admin, gone.id)).status).toBe(400);
  expect((await put(admin, boss.id)).status).toBe(200);
  expect((await getTask(admin, t)).approver.id).toBe(boss.id);
});

test("AC1: the task creator may set the approver (a creator who is not the assignee)", async ({ admin, member, later }) => {
  const { p, boss } = await setup(admin, member, later, "4.6 creator");
  const t = await newTask(admin, p.id, { assigneeId: member.user.id }); // created by the Super Admin, held by the Member
  expect((await admin.api.put(`/api/tasks/${t}/approver`, { approverId: boss.id })).status).toBe(200);
});

test("AC2: with an approver, the assignee can only hand the task to the approver, and cannot complete it", async ({ admin, member, later }) => {
  const { p, boss, t } = await setup(admin, member, later, "4.6 ac2");
  await admin.api.put(`/api/tasks/${t}/approver`, { approverId: boss.id });
  const other = await ghost(admin, later, "other");
  await admin.api.post(`/api/projects/${p.id}/members`, { userId: other.id, role: "EDITOR" });
  expect((await member.api.post(`/api/tasks/${t}/assign`, { assigneeId: other.id })).status).toBe(403);
  expect((await member.api.post(`/api/tasks/${t}/complete`)).status).toBe(403);
  expect((await getTask(admin, t)).assignee.id).toBe(member.user.id);
});

test("AC3+AC7: sending for approval makes the approver the assignee, notified, in My tasks, and remembers the previous assignee", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.6 ac3", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("4.6 handover");
  const t = await newTask(member, p.id, { title });
  await admin.api.put(`/api/tasks/${t}/approver`, { approverId: admin.user.id }); // the Leader approves
  expect((await member.api.post(`/api/tasks/${t}/send-for-approval`)).status).toBe(200);
  const held = await getTask(admin, t);
  expect(held.assignee.id).toBe(admin.user.id);
  expect(held.awaitingApproval).toBe(true);
  expect(held.previousAssigneeId).toBe(member.user.id);
  expect(JSON.stringify((await admin.api.get("/api/my-tasks")).json)).toContain(t);
  const notes = (await admin.api.get("/api/notifications")).json.items as { text: string }[];
  expect(notes.some((n) => n.text.includes(title))).toBe(true);
});

test("AC4: only the approver, the Leader or an Admin can close it; the assignee cannot, including by moving it to Done", async ({ admin, member, later }) => {
  const { p, boss, t } = await setup(admin, member, later, "4.6 ac4");
  await admin.api.put(`/api/tasks/${t}/approver`, { approverId: boss.id });
  expect((await member.api.post(`/api/tasks/${t}/complete`)).status).toBe(403);
  expect((await member.api.post(`/api/tasks/${t}/move`, { sectionId: p.done })).status).toBe(403);
  expect((await getTask(admin, t)).completedAt).toBeNull();
  expect((await admin.api.post(`/api/tasks/${t}/complete`)).status).toBe(200); // the Leader / Admin may
  expect((await getTask(admin, t)).completedAt).not.toBeNull();
});

test("AC5: Send back returns the task, open, to the previous assignee; if they are gone it goes to the Leader", async ({ admin, member, later }) => {
  const a = await setup(admin, member, later, "4.6 ac5 back");
  await admin.api.put(`/api/tasks/${a.t}/approver`, { approverId: a.boss.id });
  expect((await member.api.post(`/api/tasks/${a.t}/send-for-approval`)).status).toBe(200);
  expect((await getTask(admin, a.t)).assignee.id).toBe(a.boss.id);
  expect((await admin.api.post(`/api/tasks/${a.t}/send-back`)).status).toBe(200); // the Admin acts for the approver
  let got = await getTask(admin, a.t);
  expect(got.assignee.id).toBe(member.user.id);
  expect(got.completedAt).toBeNull();
  expect(JSON.stringify((await member.api.get("/api/my-tasks")).json)).toContain(a.t);

  const b = await setup(admin, member, later, "4.6 ac5 gone");
  await admin.api.put(`/api/tasks/${b.t}/approver`, { approverId: b.boss.id });
  await member.api.post(`/api/tasks/${b.t}/send-for-approval`);
  expect((await admin.api.del(`/api/projects/${b.p.id}/members/${member.user.id}?handoverTo=${admin.user.id}`)).status).toBe(204);
  expect((await admin.api.post(`/api/tasks/${b.t}/send-back`)).status).toBe(200);
  got = await getTask(admin, b.t);
  expect(got.assignee.id).toBe(admin.user.id); // the project Leader
});

test("AC6: with no approver the 4.3 completion rules apply unchanged (another Editor may complete)", async ({ admin, member, later }) => {
  const p = await newProject(admin, later, { label: "4.6 ac6", members: [{ who: member, role: "EDITOR" }] });
  const t = await newTask(admin, p.id);
  expect((await getTask(admin, t)).approver).toBeNull();
  expect((await member.api.post(`/api/tasks/${t}/complete`)).status).toBe(200);
});

test("AC8: when a named approver is removed from the project, the Leader becomes the approver and is told", async ({ admin, member, later }) => {
  const { p, boss, t } = await setup(admin, member, later, "4.6 ac8");
  await admin.api.put(`/api/tasks/${t}/approver`, { approverId: boss.id });
  expect((await admin.api.del(`/api/projects/${p.id}/members/${boss.id}`)).status).toBe(204); // holds nothing, so no taker is needed
  const got = await getTask(admin, t);
  expect(got.approver.id).toBe(admin.user.id);
  expect(got.assignee.id).toBe(member.user.id);
  const notes = (await admin.api.get("/api/notifications")).json.items as { text: string; href: string }[];
  const mine = notes.filter((n) => n.href.includes(p.id) && /you now approve 1 task/.test(n.text));
  expect(mine, "one counted notice for this project").toHaveLength(1);
});

test("AC9: mid-approval only the Leader or an Admin can change the approver; the new approver becomes the holder", async ({ admin, member, later }) => {
  const { p, boss, t } = await setup(admin, member, later, "4.6 ac9");
  const next = await ghost(admin, later, "newapprover");
  await admin.api.post(`/api/projects/${p.id}/members`, { userId: next.id, role: "EDITOR" });
  await admin.api.put(`/api/tasks/${t}/approver`, { approverId: boss.id });
  await member.api.post(`/api/tasks/${t}/send-for-approval`);
  expect((await member.api.put(`/api/tasks/${t}/approver`, { approverId: next.id })).status).toBe(403); // the creator, not the Leader
  expect((await admin.api.put(`/api/tasks/${t}/approver`, { approverId: next.id })).status).toBe(200);
  const got = await getTask(admin, t);
  expect(got.approver.id).toBe(next.id);
  expect(got.assignee.id).toBe(next.id);
});

test("AC3: the assignee sees 'Send for approval' and, after pressing it, 'Waiting for <approver> to approve this task.' (screen)", async ({ admin, member, later }) => {
  const { p, boss, t } = await setup(admin, member, later, "4.6 screen");
  await admin.api.put(`/api/tasks/${t}/approver`, { approverId: boss.id });
  await member.page.goto(`/projects/${p.id}?task=${t}`);
  const dlg = member.page.getByRole("dialog");
  await dlg.getByRole("button", { name: "Send for approval" }).click();
  await expect(dlg.getByText(/Waiting for .* to approve this task\./)).toBeVisible();
});
