// SHO-BUG-6 Send back with the Leader as approver and no previous assignee leaves the task stuck awaiting approval  (Linear APL-2613)
// No numbered ACs in the issue; follows its "Expected" and "Test" paragraphs. Needs a second person: skips without SHO_MEMBER_*.
import { test, expect, zz } from "../support";

test("After a send-back to the Leader-approver the task is no longer awaiting approval", async ({ admin, member, later }) => {
  const pr = await admin.api.post("/api/projects", { name: zz("sendback"), leaderId: admin.user.id });
  expect(pr.status).toBe(201);
  const pid = pr.json.project.id as string;
  later(() => admin.api.post(`/api/projects/${pid}/archive`));
  expect((await admin.api.post(`/api/projects/${pid}/members`, { userId: member.user.id, role: "EDITOR" })).status).toBe(201);
  const t = await admin.api.post(`/api/projects/${pid}/tasks`, { dueDate: "2026-11-03", title: zz("held task"), assigneeId: member.user.id, approverId: admin.user.id });
  expect(t.status, JSON.stringify(t.json)).toBe(201);
  const tid = t.json.task.id as string;

  // The member sends it for approval: it is now in the approver's hands.
  expect((await member.api.post(`/api/tasks/${tid}/send-for-approval`)).status).toBe(200);
  expect((await admin.api.get(`/api/tasks/${tid}`)).json.task.awaitingApproval).toBe(true);

  // The previous assignee leaves the project; their open tasks go to the Leader.
  const rm = await admin.api.del(`/api/projects/${pid}/members/${member.user.id}?handoverTo=${admin.user.id}`);
  expect(rm.status).toBe(204);

  // The Leader (also the approver) sends it back.
  const back = await admin.api.post(`/api/tasks/${tid}/send-back`);
  expect(back.status, JSON.stringify(back.json)).toBe(200);
  const after = (await admin.api.get(`/api/tasks/${tid}`)).json.task;
  expect(after.awaitingApproval, "not stuck awaiting approval").toBe(false);
  expect(after.assignee.id).toBe(admin.user.id);
  expect(after.approver, "approver cleared in the same write").toBeNull();
  // The Leader can work the task normally again: it can be completed.
  expect((await admin.api.post(`/api/tasks/${tid}/complete`, { expectedUpdatedAt: (await admin.api.get(`/api/tasks/${tid}`)).json.task.updatedAt })).status).toBe(200);
});
