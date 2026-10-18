// SHO-US-8.4 Clarifying questions and choices (APL-2513).
// One test per acceptance criterion. Each model turn is one short prompt. "Narrow it down" is a choice tap, not another model call.
// AC6 sends a second short message because that is the criterion: something else arrives while a question is waiting.
import { test, expect, zz } from "../support";
import { newProject, newTask } from "../g2";
import { cleanChat } from "../helpers/jim-http";
import { ask, cardOf, dueIn, nextMondayFull, postJson, replyOf, requireModel, taskOf, type ConciergeMessage } from "../helpers/jim-concierge";

test.describe.configure({ timeout: 150_000 });

test("AC1: two tasks with the same name are both offered, with the project and the due date", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us84-which" });
  const title = zz("budget");
  const first = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: dueIn(1) });
  const second = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: dueIn(5) });
  const asked = await ask(admin, `Move the "${title}" task.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const choices = replyOf(asked.messages)?.choices ?? [];
  for (const id of [first, second]) {
    const row = choices.find((c) => c.id === id);
    expect(row, id).toBeTruthy();
    expect(row!.detail ?? "").toContain(project.name);
    expect(row!.detail ?? "").toMatch(/due|20\d\d/i);
  }
  expect((await taskOf(admin, first)).dueDate).toBe(dueIn(1));
});

test("AC2: assigning a task without naming a person asks who, and assigns nobody", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us84-who" });
  const title = zz("unassigned-ask");
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id });
  const asked = await ask(admin, `Assign "${title}".`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  expect(cardOf(asked.messages), "a missing person is not guessed").toBeFalsy();
  const reply = replyOf(asked.messages);
  expect(reply?.kind === "text" || reply?.kind === "choices").toBe(true);
  expect(reply?.text).toBeTruthy();
  expect((await taskOf(admin, id)).assignee.id).toBe(admin.user.id);
});

test("AC3: when more than one task matches, the concierge does not choose one", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us84-noguess" });
  const title = zz("budget");
  const ids = [
    await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: dueIn(1) }),
    await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: dueIn(6) }),
  ];
  const asked = await ask(admin, `Move the "${title}" task to Monday.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  expect(cardOf(asked.messages)).toBeFalsy();
  const choiceIds = (replyOf(asked.messages)?.choices ?? []).map((c) => c.id);
  expect(choiceIds).toEqual(expect.arrayContaining(ids));
  for (const id of ids) expect([dueIn(1), dueIn(6)]).toContain((await taskOf(admin, id)).dueDate);
});

test("AC4: more than five matches shows five, plus None of these and Narrow it down", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us84-five" });
  const title = zz("budget");
  const ids: string[] = [];
  for (let i = 1; i <= 6; i++) ids.push(await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: dueIn(i) }));
  const asked = await ask(admin, `Move the "${title}" task.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const choices = replyOf(asked.messages)?.choices ?? [];
  const real = choices.filter((c) => c.id !== "none" && c.id !== "narrow");
  expect(real).toHaveLength(5);
  expect(real.map((c) => c.id)).not.toContain(ids[5]);
  expect(choices.some((c) => c.id === "none" && c.label === "None of these")).toBe(true);
  expect(choices.some((c) => c.id === "narrow" && c.label === "Narrow it down")).toBe(true);
  const messageId = replyOf(asked.messages)!.id;
  const narrowed = await postJson(admin, `/api/concierge/choices/${messageId}`, { choiceId: "narrow" });
  expect(narrowed.status, JSON.stringify(narrowed.json)).toBe(200);
  const follow = (narrowed.json.messages as ConciergeMessage[]).find((m) => m.role === "ASSISTANT");
  expect(follow?.text).toBeTruthy();
  expect(follow?.card).toBeFalsy();
  expect((await taskOf(admin, ids[0])).dueDate).toBe(dueIn(1));
});

test("AC5: Monday on the confirm card is the next Monday's full date", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us84-monday" });
  const title = zz("monday");
  const due = dueIn(2);
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due });
  const asked = await ask(admin, `Move "${title}" to Monday.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.status).toBe("PENDING");
  const after = (card?.changes ?? []).map((c) => c.after ?? "").join(" ");
  expect(after).toContain(nextMondayFull());
  expect((await taskOf(admin, id)).dueDate, "the resolved date is shown before confirm").toBe(due);
});

test("AC6: a new message drops a pending question and changes nothing", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us84-drop" });
  const title = zz("budget");
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: dueIn(1) });
  await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: dueIn(3) });
  const asked = await ask(admin, `Move the "${title}" task to Monday.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const pending = replyOf(asked.messages);
  expect(pending?.kind).toBe("choices");
  const dropped = await ask(admin, "Thanks");
  expect(dropped.status, JSON.stringify(dropped.json)).toBe(200);
  const state = await admin.api.get("/api/concierge/state");
  const choices = ((state.json.messages ?? []) as ConciergeMessage[]).find((m) => m.id === pending!.id);
  expect(choices?.choiceAnswered).toBe("dropped");
  expect((await taskOf(admin, id)).dueDate).toBe(dueIn(1));
});
