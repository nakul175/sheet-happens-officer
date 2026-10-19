// SHO-US-8.5 Undo from the chat (APL-2514).
// The live checks confirm a concierge card and read the thread. They skip, via requireModel, when the switch
// is off, and they do not post /api/concierge/messages in that case. A painted card is not a result.
// AC6 cannot age a stored message. The 30-day refusal is read from the source (@static).
import { readFileSync } from "node:fs";
import { test, expect, zz } from "../support";
import { newProject, newTask } from "../g2";
import { chatMessages, cleanChat } from "../helpers/jim-http";
import { ask, cardOf, dueIn, postJson, requireModel, showConcierge, taskOf } from "../helpers/jim-concierge";
import { editTask, notices } from "../helpers/claude-a";

test.describe.configure({ timeout: 150_000 });
test.use({ viewport: { width: 1440, height: 900 } });

// One skip for the whole file. The password is SHO_QA_PASS and is never generated here.
test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");

const read = (path: string) => readFileSync(path, "utf8");

test("AC1: Undo puts a concierge move back to the earlier date and the thread says so", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-undo" });
  const title = zz("undo-me");
  const due = dueIn(4);
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due });
  const asked = await ask(admin, `Move "${title}" to Monday.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.canConfirm, JSON.stringify(asked.messages)).toBe(true);
  expect((await taskOf(admin, id)).dueDate, "nothing is written before Confirm").toBe(due);
  const done = await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {});
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  expect((await taskOf(admin, id)).dueDate).not.toBe(due);
  const back = await postJson(admin, `/api/concierge/cards/${card!.id}/undo`, {});
  expect(back.status, JSON.stringify(back.json)).toBe(200);
  expect((await taskOf(admin, id)).dueDate).toBe(due);
  const thread = (await chatMessages(admin)).map((m) => m.text).join("\n");
  expect(thread).toContain("Undone");
  expect(thread).toContain("put back");
  const p = admin.page;
  await p.goto(`/projects/${project.id}`);
  await expect(p.locator("aside.cc-slot")).toContainText("Undone");
  await expect(p.locator("aside.cc-slot")).toContainText("put back");
});

// @static: the thread copy is in the source. The card undo above is the live check.
test("AC1 source: undo of a card calls undoAction and the thread says it was put back", { tag: "@static", annotation: { type: "qa:TC", description: "missing" } }, () => {
  const cards = read("src/lib/concierge/cards.ts");
  expect(cards).toContain("await undoAction(user, r.id, anyway)");
  expect(cards).toContain("Undone. Everything on that card was put back:");
});

test("AC2: Undo warns when the task changed since, and overwrites nothing", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin, member, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-conflict", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("conflict");
  const due = dueIn(3);
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due });
  const asked = await ask(admin, `Move "${title}" to Monday.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.canConfirm, JSON.stringify(asked.messages)).toBe(true);
  const done = await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {});
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  const patched = dueIn(12);
  expect((await editTask(member, id, { dueDate: patched })).status).toBe(200);
  const refused = await postJson(admin, `/api/concierge/cards/${card!.id}/undo`, {});
  expect(refused.status, JSON.stringify(refused.json)).toBe(409);
  expect(refused.json.needsConfirm).toBe("conflict");
  expect((await taskOf(admin, id)).dueDate).toBe(patched);
  const returned = (refused.json.messages as { text?: string }[] | undefined) ?? [];
  if (returned.length) expect(returned.map((m) => m.text ?? "").join("\n")).not.toContain("put back");
});

// @static: the conflict check is in the source. The 409 above is the live check.
test("AC2 source: undo asks before it overwrites a task that changed", { tag: "@static", annotation: { type: "qa:TC", description: "missing" } }, () => {
  expect(read("src/lib/concierge/cards.ts")).toContain("if (!anyway) for (const r of todo) await checkUndo(user, r.id)");
});

test("AC3: when the action notified someone, the thread says the notice cannot be unsent", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin, member, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-notice", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("notice");
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id });
  const before = (await notices(member)).map((n) => n.id);
  const asked = await ask(admin, `Assign "${title}" to the person with email ${member.user.email}.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.canConfirm, JSON.stringify(asked.messages)).toBe(true);
  const done = await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {});
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  expect((await taskOf(admin, id)).assignee.id).toBe(member.user.id);
  const sent = (await notices(member)).find((n) => !before.includes(n.id) && n.text.includes(title));
  expect(sent, "the assignee was notified").toBeTruthy();
  const back = await postJson(admin, `/api/concierge/cards/${card!.id}/undo`, {});
  expect(back.status, JSON.stringify(back.json)).toBe(200);
  expect((await taskOf(admin, id)).assignee.id).toBe(admin.user.id);
  expect((await notices(member)).some((n) => n.id === sent!.id), "the notice is still there after Undo").toBe(true);
  const thread = (await chatMessages(admin)).map((m) => m.text).join("\n");
  expect(thread).toContain("cannot be unsent");
  await admin.page.goto(`/projects/${project.id}`);
  await expect(admin.page.locator("aside.cc-slot")).toContainText("cannot be unsent");
});

// @static: the unsent-notice copy is in the source. The notice that remains above is the live check.
test("AC3 source: the thread says a notice cannot be unsent", { tag: "@static", annotation: { type: "qa:TC", description: "missing" } }, () => {
  expect(read("src/lib/concierge/cards.ts")).toContain("Notices already sent to other people cannot be unsent.");
  expect(read("src/components/concierge/MessageView.tsx")).toContain("A notice cannot be unsent");
});

test("AC4: Undo reverses every change on a card, and the thread lists them", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-whole" });
  const title = zz("whole");
  const due = dueIn(2);
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due, priority: "MEDIUM" });
  const before = await taskOf(admin, id);
  const asked = await ask(admin, `Set the priority of "${title}" to high and move it to Monday.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.canConfirm, JSON.stringify(asked.messages)).toBe(true);
  const described = JSON.stringify(card).toLowerCase();
  expect(described, "the card covers the priority").toMatch(/high|priority/);
  expect(described, "the card covers the date").toMatch(/monday|due/);
  const done = await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {});
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  const moved = await taskOf(admin, id);
  expect(moved.dueDate !== before.dueDate || moved.priority !== before.priority, "confirm wrote the card").toBe(true);
  const back = await postJson(admin, `/api/concierge/cards/${card!.id}/undo`, {});
  expect(back.status, JSON.stringify(back.json)).toBe(200);
  const restored = await taskOf(admin, id);
  expect(restored.dueDate).toBe(before.dueDate);
  expect(restored.priority).toBe(before.priority);
  const thread = (await chatMessages(admin)).map((m) => m.text).join("\n");
  expect(thread).toContain("Reversed");
  await admin.page.goto(`/projects/${project.id}`);
  await expect(admin.page.locator("aside.cc-slot")).toContainText("Reversed");
});

// @static: the reversed-line copy is in the source. The card undo above is the live check.
test("AC4 source: undo lists every reversed change on the card", { tag: "@static", annotation: { type: "qa:TC", description: "missing" } }, () => {
  const cards = read("src/lib/concierge/cards.ts");
  expect(cards).toContain("const lines = rs.result.summary.map((x) => `- Reversed: ${x}`)");
  expect(cards).toContain("for (const r of todo)");
});

test("AC5: a member-removal card says it cannot be undone, and the done message has no Undo", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin, member, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-irrev", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("handover");
  const id = await newTask(admin, project.id, { title, assigneeId: member.user.id });
  const asked = await ask(admin, `Remove the person with email ${member.user.email} from ${project.name}.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.irreversible, JSON.stringify(asked.messages)).toBe(true);
  expect(card?.handover?.some((h) => h.taskId === id && h.taskTitle === title)).toBe(true);
  const p = admin.page;
  await p.goto(`/projects/${project.id}`);
  const dock = p.locator("aside.cc-slot");
  await expect(dock.locator(".cc-warn")).toContainText("This can't be undone");
  const refused = await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {});
  expect(refused.status, JSON.stringify(refused.json)).toBe(400);
  const still = (await admin.api.get(`/api/projects/${project.id}`)).json.project.members as { userId: string }[];
  expect(still.some((m) => m.userId === member.user.id)).toBe(true);
  const done = await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {
    acknowledge: true,
    handover: [{ taskId: id, assigneeId: admin.user.id }],
  });
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  const result = (done.json.messages as { result?: { undoable?: boolean } }[])[0]?.result;
  expect(result?.undoable).toBe(false);
  expect((await taskOf(admin, id)).assignee.id).toBe(admin.user.id);
  const gone = (await admin.api.get(`/api/projects/${project.id}`)).json.project.members as { userId: string }[];
  expect(gone.some((m) => m.userId === member.user.id)).toBe(false);
  await p.reload();
  await expect(dock.getByRole("button", { name: "Undo" })).toHaveCount(0);
});

// @static: the irreversible copy is in the source. The removal card above is the live check.
test("AC5 source: a member-removal card cannot be undone", { tag: "@static", annotation: { type: "qa:TC", description: "missing" } }, () => {
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
test("AC6: a done message older than 30 days has Undo greyed out, saying it is too old", { tag: "@static", annotation: { type: "qa:TC", description: "missing" } }, () => {
  const thread = read("src/lib/concierge/thread.ts");
  const cards = read("src/lib/concierge/cards.ts");
  const days = read("src/lib/undoable.ts");
  expect(days).toContain("export const UNDO_DAYS = 30");
  expect(thread).toContain("undoExpired");
  expect(thread).toContain("UNDO_DAYS");
  expect(cards).toContain('throw new ApiError(409, "Too old to undo"');
  expect(read("src/components/concierge/MessageView.tsx")).toContain("Too old to undo");
});
