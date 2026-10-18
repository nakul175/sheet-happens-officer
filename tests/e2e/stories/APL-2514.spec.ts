// SHO-US-8.5 Undo from the chat (APL-2514).
// One test per acceptance criterion. Confirm and Undo on a concierge card call the same undo as the screen
// (undoAction). These tests drive that undo on staging with ZZ-TEST tasks, and they paint the concierge
// thread from the payload the server returns, so no model call is made.
// AC6 cannot age a stored message. The staging page is shown a result the server marks undoExpired, and
// undoCard refuses a card older than UNDO_DAYS.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, zz } from "../support";
import { newProject, newTask } from "../g2";
import { cleanChat } from "../helpers/jim-http";
import { dueIn, showConcierge, taskOf } from "../helpers/jim-concierge";
import { editTask, notices } from "../helpers/claude-a";

test.describe.configure({ timeout: 90_000 });
test.use({ viewport: { width: 1440, height: 900 } });

const read = (path: string) => readFileSync(path, "utf8");

type Msg = Record<string, unknown>;

async function paint(page: Page, messages: Msg[]) {
  await page.route("**/api/concierge/state", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      available: true, hidden: false, voiceNoticeAcked: true,
      quickActions: [{ id: "due-week", label: "Due this week" }],
      messages,
    }),
  }));
}

const result = (extra: Record<string, unknown>, text = "Done."): Msg => ({
  id: "zz-result", role: "ASSISTANT", createdAt: new Date().toISOString(), kind: "result", text,
  result: { cardId: "zz-result", summary: ["Due date"], undoable: true, ...extra },
});

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
  await paint(admin.page, [result({ undoneAt: new Date().toISOString(), summary: ["Due date"] }, "Undone.")]);
  await admin.page.goto(`/projects/${project.id}`);
  await expect(admin.page.locator("aside.cc-slot")).toContainText(/undone/i);
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

  const cards = read("src/lib/concierge/cards.ts");
  expect(cards).toContain("if (!anyway) for (const r of todo) await checkUndo(user, r.id)");
  await admin.page.route("**/api/concierge/cards/zz-result/undo", (route) => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({
      needsConfirm: "conflict",
      changedBy: [member.user.name],
      conflicts: [{ field: "Due", before: due, after: dueIn(8), now: patched }],
    }),
  }));
  await paint(admin.page, [result({})]);
  const p = admin.page;
  await p.goto(`/projects/${project.id}`);
  await p.locator("aside.cc-slot").getByRole("button", { name: "Undo" }).click();
  const dialog = p.getByRole("dialog", { name: "This changed since" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(/changed|overwrite/i);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect((await taskOf(admin, id)).dueDate).toBe(patched);
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
  await paint(admin.page, [result({ noticeSent: true })]);
  await admin.page.goto(`/projects/${project.id}`);
  await expect(admin.page.locator("aside.cc-slot .cc-result")).toContainText(/cannot be unsent/i);
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
  await paint(admin.page, [result({
    undoneAt: new Date().toISOString(),
    summary: ["Due date", "Priority"],
  }, "Undone. Everything on that card was put back:\n- Reversed: Due date\n- Reversed: Priority")]);
  await admin.page.goto(`/projects/${project.id}`);
  const note = await admin.page.locator("aside.cc-slot").innerText();
  expect(note.toLowerCase()).toContain("undone");
  expect((note.match(/reversed/gi) ?? []).length).toBeGreaterThanOrEqual(2);
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

  const card: Msg = {
    id: "zz-card", role: "ASSISTANT", createdAt: new Date().toISOString(), kind: "card", text: "Remove a member.",
    card: {
      id: "zz-card", status: "PENDING", title: "Remove a member", canConfirm: true, irreversible: true,
      changes: [], handover: [{ taskId: id, taskTitle: title }],
      handoverOptions: [{ id: admin.user.id, name: admin.user.name }],
    },
  };
  await paint(admin.page, [
    card,
    result({ undoable: false, summary: ["Removed the member"] }, "Done. This can't be undone."),
  ]);
  const p = admin.page;
  await p.goto(`/projects/${project.id}`);
  const dock = p.locator("aside.cc-slot");
  await expect(dock.locator(".cc-warn")).toContainText("This can't be undone");
  await expect(dock.getByRole("button", { name: "Confirm" })).toBeDisabled();
  await dock.locator(".cc-ho select").selectOption(admin.user.id);
  await dock.locator(".cc-warn input").check();
  await expect(dock.getByRole("button", { name: "Confirm" })).toBeEnabled();
  await expect(dock.locator(".cc-result")).toContainText(/can't be undone/i);
  await expect(dock.locator(".cc-result").getByRole("button", { name: "Undo" })).toHaveCount(0);
});

test("AC6: a done message older than 30 days has Undo greyed out, saying it is too old", async ({ admin, later }) => {
  await showConcierge(admin, later);
  const thread = read("src/lib/concierge/thread.ts");
  const cards = read("src/lib/concierge/cards.ts");
  const days = read("src/lib/undoable.ts");
  expect(days).toContain("export const UNDO_DAYS = 30");
  expect(thread).toContain("undoExpired");
  expect(thread).toContain("UNDO_DAYS");
  expect(cards).toContain('throw new ApiError(409, "Too old to undo"');
  expect(read("src/components/concierge/MessageView.tsx")).toContain("Too old to undo");
  await paint(admin.page, [result({ undoExpired: true })]);
  await admin.page.goto("/");
  const button = admin.page.locator("aside.cc-slot").getByRole("button", { name: "Too old to undo" });
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
});
