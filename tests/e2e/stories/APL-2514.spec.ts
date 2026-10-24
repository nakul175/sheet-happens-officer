// SHO-US-8.5 Undo from the chat (APL-2514).
// One test per acceptance criterion. The prompt proposes the change; Confirm and Undo are taps, not further model calls.
// AC6 uses an explicitly owned local database fixture to age a result; it never changes staging data.
import { randomUUID } from "node:crypto";
import { localPgPool, schemaFromDatabaseUrl } from "../helpers/local-db-pool";
import { test, expect, zz, BASE_URL } from "../support";
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
  const due = dueIn(4);
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
  const due = dueIn(3);
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
  const due = dueIn(2);
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due });
  const asked = await ask(admin, `Set "${title}" to high priority and move it to Monday.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.canConfirm).toBe(true);
  expect((card?.changes ?? []).length).toBeGreaterThanOrEqual(2);
  const done = await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {});
  expect(done.status, JSON.stringify(done.json)).toBe(200);
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

test("AC6: a done message older than 30 days has Undo greyed out, saying it is too old", async ({ admin, later }) => {
  const database = process.env.DATABASE_URL;
  const schema = database ? schemaFromDatabaseUrl(database) : undefined;
  expect(["127.0.0.1", "localhost"]).toContain(new URL(BASE_URL).hostname);
  expect(schema).toMatch(/^sho_2708_[a-z0-9_]+$/);
  expect(process.env.SHO_OWNED_TEST_SCHEMA).toBe(schema);
  const id = randomUUID().replaceAll("-", "");
  const old = new Date(Date.now() - 31 * 86400_000).toISOString();
  const content = JSON.stringify({ kind: "result", text: "ZZ-TEST aged completed change", crmHidden: true,
    result: { cardId: id, summary: ["ZZ-TEST aged completed change"], undoable: true },
    internal: { confirmedAt: old, logIds: [] } });
  const pool = localPgPool(database);
  try {
    const actor = await pool.query('SELECT email FROM "User" WHERE id=$1', [admin.user.id]);
    expect(actor.rows[0]?.email).toBe(admin.user.email);
    await pool.query('INSERT INTO "ChatMessage"(id,"userId",role,content,"createdAt") VALUES ($1,$2,\'ASSISTANT\',$3,NOW())', [id, admin.user.id, content]);
    const thread = await admin.api.get("/api/concierge/state");
    expect(thread.json.messages.find((m: ConciergeMessage) => m.id === id)?.result?.undoExpired).toBe(true);
    await showConcierge(admin, later);
    await admin.page.goto("/");
    const result = admin.page.locator(".cc-result").filter({ hasText: "ZZ-TEST aged completed change" });
    await expect(result.getByRole("button", { name: "Too old to undo" })).toBeDisabled();
    await expect(result.getByRole("button", { name: /^Undo$/ })).toHaveCount(0);
    test.info().annotations.push({ type: "evidence-scope", description: "Owned local aged-result fixture; actual API expiry and browser disabled state, not a live model proposal or staging receipt." });
  } finally {
    await pool.query('DELETE FROM "ChatMessage" WHERE id=$1 AND "userId"=$2', [id, admin.user.id]);
    await pool.end();
  }
});
