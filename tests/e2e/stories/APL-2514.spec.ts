// SHO-US-8.5 Undo from the chat (APL-2514).
// One test per acceptance criterion. Confirm and Undo on a concierge card call the same undo as the screen
// (undoAction). These tests drive that undo on staging with ZZ-TEST tasks. A painted card or toast is not
// a result, and this file does not post /api/concierge/messages.
// AC6 cannot age a stored message. The 30-day refusal is read from the source (@static), not from a painted button.
import { readFileSync } from "node:fs";
import { test, expect, zz } from "../support";
import { newProject, newTask } from "../g2";
import { cleanChat } from "../helpers/jim-http";
import { dueIn, showConcierge, taskOf } from "../helpers/jim-concierge";
import { editTask, notices } from "../helpers/claude-a";

test.describe.configure({ timeout: 90_000 });
test.use({ viewport: { width: 1440, height: 900 } });

// One skip for the whole file. The password is SHO_QA_PASS and is never generated here.
test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");

const read = (path: string) => readFileSync(path, "utf8");

test("AC1: Undo puts a concierge move back to the earlier date and the thread says so", async ({ admin, later }) => {
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-undo" });
  const title = zz("undo-me");
  const due = dueIn(4);
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due });
  const moved = dueIn(10);
  const edited = await editTask(admin, id, { dueDate: moved });
  expect(edited.status, JSON.stringify(edited.json)).toBe(200);
  expect(edited.headers["x-undo-id"], "the move is undoable").toBeTruthy();
  expect((await taskOf(admin, id)).dueDate).toBe(moved);
  const back = await admin.api.post(`/api/actions/${edited.headers["x-undo-id"]}/undo`, {});
  expect(back.status, JSON.stringify(back.json)).toBe(200);
  expect((await taskOf(admin, id)).dueDate).toBe(due);
  const cards = read("src/lib/concierge/cards.ts");
  expect(cards).toContain("await undoAction(user, r.id, anyway)");
  expect(cards).toContain("Undone. Everything on that card was put back:");
});

test("AC2: Undo warns when the task changed since, and overwrites nothing", async ({ admin, member, later }) => {
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-conflict", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("conflict");
  const due = dueIn(3);
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due });
  const first = await editTask(admin, id, { dueDate: dueIn(8) });
  expect(first.status, JSON.stringify(first.json)).toBe(200);
  const patched = dueIn(12);
  expect((await editTask(member, id, { dueDate: patched })).status).toBe(200);
  const refused = await admin.api.post(`/api/actions/${first.headers["x-undo-id"]}/undo`, {});
  expect(refused.status, JSON.stringify(refused.json)).toBe(409);
  expect(refused.json.needsConfirm).toBe("conflict");
  expect((await taskOf(admin, id)).dueDate).toBe(patched);
  expect(read("src/lib/concierge/cards.ts")).toContain("if (!anyway) for (const r of todo) await checkUndo(user, r.id)");
});

test("AC3: when the action notified someone, the thread says the notice cannot be unsent", async ({ admin, member, later }) => {
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-notice", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("notice");
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id });
  const before = (await notices(member)).map((n) => n.id);
  const edited = await editTask(admin, id, { assigneeId: member.user.id });
  expect(edited.status, JSON.stringify(edited.json)).toBe(200);
  const sent = (await notices(member)).find((n) => !before.includes(n.id) && n.text.includes(title));
  expect(sent, "the assignee was notified").toBeTruthy();
  const back = await admin.api.post(`/api/actions/${edited.headers["x-undo-id"]}/undo`, {});
  expect(back.status, JSON.stringify(back.json)).toBe(200);
  expect((await taskOf(admin, id)).assignee.id).toBe(admin.user.id);
  expect((await notices(member)).some((n) => n.id === sent!.id), "the notice is still there after Undo").toBe(true);
  expect(read("src/lib/concierge/cards.ts")).toContain("Notices already sent to other people cannot be unsent.");
  expect(read("src/components/concierge/MessageView.tsx")).toContain("A notice cannot be unsent");
});

test("AC4: Undo reverses every change on a card, and the thread lists them", async ({ admin, later }) => {
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-whole" });
  const title = zz("whole");
  const due = dueIn(2);
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due });
  const dueEdit = await editTask(admin, id, { dueDate: dueIn(9) });
  const priEdit = await editTask(admin, id, { priority: "HIGH" });
  expect(dueEdit.status, JSON.stringify(dueEdit.json)).toBe(200);
  expect(priEdit.status, JSON.stringify(priEdit.json)).toBe(200);
  for (const row of [priEdit, dueEdit]) {
    const back = await admin.api.post(`/api/actions/${row.headers["x-undo-id"]}/undo`, {});
    expect(back.status, JSON.stringify(back.json)).toBe(200);
  }
  const task = await taskOf(admin, id);
  expect(task.dueDate).toBe(due);
  expect(task.priority).toBe("MEDIUM");
  const cards = read("src/lib/concierge/cards.ts");
  expect(cards).toContain("const lines = rs.result.summary.map((x) => `- Reversed: ${x}`)");
  expect(cards).toContain("for (const r of todo)");
});

test("AC5: a member-removal card says it cannot be undone, and the done message has no Undo", async ({ admin, member, later }) => {
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-irrev", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("handover");
  const id = await newTask(admin, project.id, { title, assigneeId: member.user.id });
  expect((await admin.api.del(`/api/projects/${project.id}/members/${member.user.id}?handoverTo=${admin.user.id}`)).status).toBe(204);
  const members = (await admin.api.get(`/api/projects/${project.id}`)).json.project.members as { userId: string }[];
  expect(members.some((m) => m.userId === member.user.id)).toBe(false);
  expect((await taskOf(admin, id)).assignee.id).toBe(admin.user.id);
  const changes = read("src/lib/concierge/changes.ts");
  expect(changes).toContain("irreversible = tasks.length > 0");
  expect(changes).toContain("await removeMember(user, op.projectId, op.userId, undefined, picks)");
  const cards = read("src/lib/concierge/cards.ts");
  expect(cards).toContain("const undoable = !s.card.irreversible");
  expect(cards).toContain('throw new ApiError(409, "This can\'t be undone.")');
  const view = read("src/components/concierge/MessageView.tsx");
  expect(view).toContain("This can&apos;t be undone");
  expect(view).toContain('view === "none"');
});

// @static: the 30-day copy is in the source. A painted "Too old to undo" button is not a live message.
test("AC6: a done message older than 30 days has Undo greyed out, saying it is too old", { tag: "@static" }, () => {
  const thread = read("src/lib/concierge/thread.ts");
  const cards = read("src/lib/concierge/cards.ts");
  const days = read("src/lib/undoable.ts");
  expect(days).toContain("export const UNDO_DAYS = 30");
  expect(thread).toContain("undoExpired");
  expect(thread).toContain("UNDO_DAYS");
  expect(cards).toContain('throw new ApiError(409, "Too old to undo"');
  expect(read("src/components/concierge/MessageView.tsx")).toContain("Too old to undo");
});
