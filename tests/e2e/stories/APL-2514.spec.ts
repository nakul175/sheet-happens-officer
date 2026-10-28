import { dueBeforeNextMonday } from "../helpers/proposal-fixture-date";
// SHO-US-8.5 Undo from the chat (APL-2514).
// One test per acceptance criterion. The prompt proposes the change; Confirm and Undo are taps, not further model calls.
// AC6 ages only a fresh synthetic actor's confirmed local card and action-log rows.
import { ownedAging } from "../helpers/owned-local-aging";
import { verifiedUser, deactivate } from "./qa";
import { test, expect, zz } from "../support";
import { newProject, newTask } from "../g2";
import { cleanChat, patchCurrent } from "../helpers/jim-http";
import { ask, cardOf, dueIn, postJson, requireConcierge, requireModel, showConcierge, taskOf, type ConciergeMessage } from "../helpers/jim-concierge";

test.describe.configure({ timeout: 150_000 });
test.use({ viewport: { width: 1440, height: 900 } });

test("AC1: Undo puts a concierge move back to the earlier date and the thread says so", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-undo" });
  const title = zz("undo-me");
  const due = dueBeforeNextMonday();
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due });
  const asked = await ask(admin, `Move "${title}" to Monday.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.canConfirm).toBe(true);
  const done = await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {});
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  expect((await taskOf(admin, id)).dueDate).not.toBe(due);
  const back = await postJson(admin, `/api/concierge/cards/${card!.id}/undo`, {});
  expect(back.status, JSON.stringify(back.json)).toBe(200);
  expect(JSON.stringify(back.json.messages).toLowerCase()).toContain("undone");
  expect((await taskOf(admin, id)).dueDate).toBe(due);
});

test("AC2: Undo warns when the task changed since, and overwrites nothing", async ({ admin, later }) => {
  await requireModel(admin);
  await requireConcierge(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-conflict" });
  const title = zz("conflict");
  const due = dueBeforeNextMonday();
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due });
  const asked = await ask(admin, `Move "${title}" to Monday.`);
  const card = cardOf(asked.messages);
  expect((await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {})).status).toBe(200);
  const patched = dueIn(12);
  expect((await patchCurrent(admin, id, { dueDate: patched })).status).toBe(200);
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
  await requireModel(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-notice", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("notice");
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id });
  const asked = await ask(admin, `Assign "${title}" to the person with email ${member.user.email}.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.canConfirm).toBe(true);
  const done = await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {});
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  const result = (done.json.messages as ConciergeMessage[])[0]?.result;
  expect(result?.noticeSent).toBe(true);
  expect((await taskOf(admin, id)).assignee.id).toBe(member.user.id);
  const p = admin.page;
  await p.goto(`/projects/${project.id}`);
  await expect(p.locator("aside.cc-slot .cc-result")).toContainText(/cannot be unsent/i);
});

test("AC4: Undo reverses every change on a card, and the thread lists them", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-whole" });
  const title = zz("whole");
  const due = dueBeforeNextMonday();
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due });
  // A card row is an operation, and multiple fields on one task may correctly share one edit operation.
  // Two distinct task IDs guarantee this criterion really tests reversing more than one operation.
  const priorityTitle = zz("whole-priority");
  const priorityId = await newTask(admin, project.id, { title: priorityTitle, assigneeId: admin.user.id, dueDate: due });
  const asked = await ask(admin, `Move "${title}" to Monday and set "${priorityTitle}" to high priority.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.canConfirm).toBe(true);
  expect((card?.changes ?? []).length).toBeGreaterThanOrEqual(2);
  const done = await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {});
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  expect((await taskOf(admin, id)).dueDate).not.toBe(due);
  expect((await taskOf(admin, priorityId)).priority).toBe("HIGH");
  const summary = (done.json.messages as ConciergeMessage[])[0]?.result?.summary ?? [];
  expect(summary.length).toBeGreaterThanOrEqual(2);
  const back = await postJson(admin, `/api/concierge/cards/${card!.id}/undo`, {});
  expect(back.status, JSON.stringify(back.json)).toBe(200);
  const note = JSON.stringify(back.json.messages);
  expect(note.toLowerCase()).toContain("undone");
  expect((note.match(/reversed/gi) ?? []).length).toBeGreaterThanOrEqual(2);
  const task = await taskOf(admin, id);
  expect(task.dueDate).toBe(due);
  expect(task.priority).toBe("MEDIUM");
  expect((await taskOf(admin, priorityId)).priority).toBe("MEDIUM");
  expect((await taskOf(admin, priorityId)).dueDate).toBe(due);
});

test("AC5: a member-removal card says it cannot be undone, and the done message has no Undo", async ({ admin, member, later }) => {
  await requireModel(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us85-irrev", members: [{ who: member, role: "EDITOR" }] });
  const title = zz("handover");
  const id = await newTask(admin, project.id, { title, assigneeId: member.user.id });
  const asked = await ask(admin, `Remove the person with email ${member.user.email} from ${project.name}.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.irreversible).toBe(true);
  expect(card?.handover?.some((h) => h.taskId === id)).toBe(true);
  const p = admin.page;
  await p.goto(`/projects/${project.id}`);
  const dock = p.locator("aside.cc-slot");
  await expect(dock.locator(".cc-warn")).toContainText("This can't be undone");
  await expect(dock.getByRole("button", { name: "Confirm" })).toBeDisabled();
  await dock.locator(".cc-ho select").selectOption(admin.user.id);
  await dock.locator(".cc-warn input").check();
  await dock.getByRole("button", { name: "Confirm" }).click();
  await expect(dock.locator(".cc-result")).toContainText(/can't be undone/i);
  await expect(dock.locator(".cc-result").getByRole("button", { name: "Undo" })).toHaveCount(0);
  const members = (await admin.api.get(`/api/projects/${project.id}`)).json.project.members as { userId: string }[];
  expect(members.some((m) => m.userId === member.user.id)).toBe(false);
  expect((await taskOf(admin, id)).assignee.id).toBe(admin.user.id);
});

test("AC6: a done message older than 30 days has Undo greyed out, saying it is too old @local-only", async ({ browser, anon, admin, later }) => {
  const who = await verifiedUser(browser, anon.context().request, "2514", "expired");
  later(() => who.ctx.close());
  later(() => deactivate(admin.api,who.user.id));
  const aging=await ownedAging(who.user);
  later(() => aging.close());
  await requireModel(who);
  await showConcierge(who,later);
  await cleanChat(who,later);
  const project=await newProject(admin,later,{label:"expired-undo",members:[{who,role:"EDITOR"}]});
  const title=zz("expired-task"),due=dueBeforeNextMonday();
  const id=await newTask(who,project.id,{title,assigneeId:who.user.id,dueDate:due});
  const asked=await ask(who,`Move "${title}" to Monday.`);
  expect(asked.status,JSON.stringify(asked.json)).toBe(200);
  const card=cardOf(asked.messages);
  expect(card?.canConfirm).toBe(true);
  const done=await postJson(who,`/api/concierge/cards/${card!.id}/confirm`,{});
  expect(done.status,JSON.stringify(done.json)).toBe(200);
  const result=(done.json.messages as ConciergeMessage[]).find(m=>m.result);
  expect(result?.id).toBeTruthy();
  const before=await taskOf(who,id);
  expect(before.dueDate).not.toBe(due);
  await aging.expireUndo(card!.id,result!.id,new Date(Date.now()-31*86400000));
  await who.page.goto(`/projects/${project.id}`);
  const expired=who.page.locator("aside.cc-slot .cc-result").filter({hasText:title});
  await expect(expired.getByRole("button",{name:"Too old to undo",exact:true})).toBeVisible();
  await expect(expired.getByRole("button",{name:"Too old to undo",exact:true})).toBeDisabled();
  await expect(expired.getByRole("button",{name:"Undo",exact:true})).toHaveCount(0);
  const state=await who.api.get("/api/concierge/state");
  expect(state.json.messages.find((m:ConciergeMessage)=>m.id===result!.id)?.result?.undoExpired).toBe(true);
  const refused=await postJson(who,`/api/concierge/cards/${card!.id}/undo`,{});
  expect(refused.status,JSON.stringify(refused.json)).toBe(409);
  expect(refused.json.tooOld).toBe(true);
  expect(await taskOf(who,id)).toEqual(before);
});
