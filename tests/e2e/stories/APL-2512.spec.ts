// SHO-US-8.3 Propose a change and confirm it (APL-2512).
// One test per acceptance criterion, and one short prompt in each. Nothing is confirmed unless that criterion is the confirm itself.
// ZZ-TEST projects are archived afterwards; the concierge thread is cleared when it started empty.
import { test, expect, zz } from "../support";
import { ghost, newProject, newTask } from "../g2";
import { cleanChat, patchCurrent } from "../helpers/jim-http";
import { ask, cardOf, dueIn, postJson, replyOf, requireModel, showConcierge, taskOf } from "../helpers/jim-concierge";

test.describe.configure({ timeout: 150_000 });

const activity = async (who: { api: { get: (p: string) => Promise<{ json: { items?: unknown[] } }> } }, projectId: string) =>
  ((await who.api.get(`/api/projects/${projectId}/activity`)).json.items ?? []) as { what: string; via?: string }[];

test("AC1: moving a task to Monday shows the old and new date, and nothing changes until Confirm", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us83-move" });
  const title = zz("budget");
  const due = dueIn(3);
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due });
  const asked = await ask(admin, `Move "${title}" to Monday.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.status).toBe("PENDING");
  expect(card?.canConfirm).toBe(true);
  const change = (card?.changes ?? []).find((c) => c.before && c.after);
  expect(change?.before).toBeTruthy();
  expect(change?.after).toBeTruthy();
  expect(change!.before).not.toBe(change!.after);
  expect((await taskOf(admin, id)).dueDate, "nothing is written before Confirm").toBe(due);
});

test("AC2: without the right to change a task, there is no Confirm, and the server refuses the tap", async ({ admin, member, later }) => {
  await requireModel(member);
  await cleanChat(member, later);
  const project = await newProject(admin, later, { label: "us83-viewer", members: [{ who: member, role: "VIEWER" }] });
  const title = zz("viewer-task");
  const due = dueIn(2);
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due });
  const asked = await ask(member, `Move "${title}" to Monday.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card, "the refusal is a card with no Confirm").toBeTruthy();
  expect(card!.canConfirm).toBe(false);
  expect(card!.blockedReason).toBeTruthy();
  const refused = await postJson(member, `/api/concierge/cards/${card!.id}/confirm`, {});
  expect(refused.status, JSON.stringify(refused.json)).toBe(403);
  expect((await taskOf(admin, id)).dueDate).toBe(due);
});

test("AC3: asking to deactivate a person points at the screen and does not do it", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const person = await ghost(admin, later, "deactivate");
  const asked = await ask(admin, `Deactivate the person with email ${person.email}.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  expect(cardOf(asked.messages), "deactivating a person is not a concierge card").toBeFalsy();
  const reply = replyOf(asked.messages);
  expect(reply?.text).toMatch(/team|screen/i);
  const people = (await admin.api.get("/api/team")).json.people as { id: string; status?: string }[];
  expect(people.find((p) => p.id === person.id)?.status).not.toBe("DEACTIVATED");
});

test("AC4: a request to change something writes nothing until Confirm is tapped", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us83-silent" });
  const title = zz("silent");
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id });
  const before = await activity(admin, project.id);
  const asked = await ask(admin, `Complete "${title}".`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  expect(asked.messages.some((m) => m.kind === "result")).toBe(false);
  expect((await taskOf(admin, id)).completedAt).toBeFalsy();
  const after = await activity(admin, project.id);
  expect(after.length, "no action was logged for a proposal").toBe(before.length);
});

test("AC5: a request that matches two tasks asks which one and does not guess", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us83-which" });
  const title = zz("budget");
  const first = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: dueIn(1) });
  const second = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: dueIn(4) });
  const asked = await ask(admin, `Move the "${title}" task to Monday.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  expect(cardOf(asked.messages), "more than one match is not a card").toBeFalsy();
  const choices = replyOf(asked.messages)?.choices ?? [];
  const ids = choices.map((c) => c.id);
  expect(ids).toContain(first);
  expect(ids).toContain(second);
  expect((await taskOf(admin, first)).dueDate).toBe(dueIn(1));
  expect((await taskOf(admin, second)).dueDate).toBe(dueIn(4));
});

test("AC6: a request for more than 10 changes makes no card and leaves the tasks alone", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us83-ten" });
  const ids: string[] = [];
  for (let i = 0; i < 11; i++) ids.push(await newTask(admin, project.id, { title: zz(`batch-${i}`), assigneeId: admin.user.id }));
  const asked = await ask(admin, `Complete every open task in ${project.name}. There are 11.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  expect(cardOf(asked.messages), "more than 10 changes is not a card").toBeFalsy();
  expect(replyOf(asked.messages)?.text).toBeTruthy();
  for (const id of ids) expect((await taskOf(admin, id)).completedAt).toBeFalsy();
});

test("AC7: confirming after the task changed writes nothing and returns a fresh card", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us83-stale" });
  const title = zz("stale");
  const due = dueIn(2);
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due });
  const asked = await ask(admin, `Move "${title}" to Monday.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.canConfirm).toBe(true);
  const patched = dueIn(12);
  expect((await patchCurrent(admin, id, { dueDate: patched })).status).toBe(200);
  const refused = await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {});
  expect(refused.status, JSON.stringify(refused.json)).toBe(409);
  expect(refused.json.stale).toBe(true);
  const fresh = (refused.json.messages as { card?: { status: string } }[] | undefined)?.find((m) => m.card);
  expect(fresh?.card?.status).toBe("PENDING");
  expect((await taskOf(admin, id)).dueDate, "the fresh card has not been applied").toBe(patched);
});

test("AC8: removing a member who holds tasks lists those tasks, blocks Confirm until someone takes them, and says it cannot be undone", async ({ admin, member, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us83-remove", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("held");
  const id = await newTask(admin, project.id, { title, assigneeId: member.user.id });
  const asked = await ask(admin, `Remove the person with email ${member.user.email} from ${project.name}.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.handover?.some((h) => h.taskId === id && h.taskTitle === title)).toBe(true);
  expect(card?.irreversible).toBe(true);
  const p = admin.page;
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.goto(`/projects/${project.id}`);
  const dock = p.locator("aside.cc-slot");
  await expect(dock.locator(".cc-handover")).toContainText(title);
  await expect(dock.locator(".cc-warn")).toContainText("This can't be undone");
  await expect(dock.getByRole("button", { name: "Confirm" })).toBeDisabled();
  const refused = await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {});
  expect(refused.status, JSON.stringify(refused.json)).toBe(400);
  const members = (await admin.api.get(`/api/projects/${project.id}`)).json.project.members as { userId: string }[];
  expect(members.some((m) => m.userId === member.user.id)).toBe(true);
});

test("AC9: confirming a deletion sends the task to Trash, with Undo", async ({ admin, member, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us83-trash", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("bin");
  const id = await newTask(admin, project.id, { title, assigneeId: member.user.id });
  const asked = await ask(admin, `Delete "${title}".`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.canConfirm).toBe(true);
  const done = await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {});
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  const result = (done.json.messages as { result?: { undoable: boolean; noticeSent?: boolean } }[])[0]?.result;
  expect(result?.undoable).toBe(true);
  expect(result?.noticeSent, "the assignee, who is not the person confirming, is notified").toBe(true);
  expect((await admin.api.get(`/api/tasks/${id}`)).status).toBe(404);
  const trash = (await admin.api.get(`/api/projects/${project.id}/trash`)).json.items as { id: string }[];
  expect(trash.some((t) => t.id === id)).toBe(true);
  const rows = await activity(admin, project.id);
  expect(rows.some((r) => r.via === "concierge" && /trash/i.test(r.what))).toBe(true);
});
