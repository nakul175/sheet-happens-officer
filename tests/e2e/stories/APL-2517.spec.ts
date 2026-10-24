import { dueBeforeNextMonday } from "../helpers/proposal-fixture-date";
// SHO-US-8.8 Private chat history kept 90 days (APL-2517).
// One test per acceptance criterion. AC2 cannot run the retention job or age a message, so it skips.
// AC3 is the one model prompt: a confirmed change. The other checks use a quick action or the privacy line.
import { test, expect, zz } from "../support";
import { newProject, newTask } from "../g2";
import { chatMessages, cleanChat, quickAction } from "../helpers/jim-http";
import { ask, cardOf, postJson, requireConcierge, requireModel, showConcierge } from "../helpers/jim-concierge";

test.describe.configure({ timeout: 150_000 });
test.use({ viewport: { width: 1440, height: 900 } });

const PROMISE = "Your chats are not visible anywhere in the app to anyone else, and are deleted from the app after 90 days.";

test("AC1: no screen or endpoint returns another person's chat", async ({ admin, member, later }) => {
  await requireModel(member);
  await requireConcierge(admin);
  await showConcierge(admin, later);
  await cleanChat(member, later);
  await cleanChat(admin, later);
  const token = zz("private-chat");
  const asked = await ask(member, token);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const mine = await chatMessages(member);
  expect(JSON.stringify(mine)).toContain(token);
  const messageId = mine.at(-1)!.id;
  expect(JSON.stringify(await chatMessages(admin))).not.toContain(token);
  // The Admin's session, aimed at the Member's message id, looks the same as a missing message.
  const asAdmin = await admin.page.context().request.fetch(`/api/concierge/choices/${messageId}`, {
    method: "POST", headers: { "content-type": "application/json" }, data: { choiceId: "none" },
  });
  expect(asAdmin.status()).toBe(404);
  expect(await asAdmin.text()).not.toContain(token);
  const listed = await admin.api.get(`/api/concierge/messages?userId=${member.user.id}`);
  expect(listed.status).not.toBe(200);
  expect(JSON.stringify(listed.json)).not.toContain(token);
  const audit = await admin.api.get("/api/audit");
  expect(JSON.stringify(audit.json)).not.toContain(token);
  await admin.page.goto("/");
  await expect(admin.page.locator("aside.cc-slot")).not.toContainText(token);
});

test("AC2: a message older than 90 days is deleted by the retention job", async () => {
  test.skip(true, "A browser session cannot age a concierge message past 90 days or run the retention job. tests/concierge.test.ts covers purgeChat.");
});

test("AC3: a change made through chat is in the action log, and the chat text is not", async ({ admin, later }) => {
  await requireModel(admin);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us88-log" });
  const title = zz("logged");
  const marker = zz("chat-only");
  const due = dueBeforeNextMonday();
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: due });
  const asked = await ask(admin, `Move "${title}" to Monday. ${marker}`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card?.canConfirm).toBe(true);
  const done = await postJson(admin, `/api/concierge/cards/${card!.id}/confirm`, {});
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  expect((await admin.api.get(`/api/tasks/${id}`)).json.task.dueDate).not.toBe(due);
  const rows = (await admin.api.get(`/api/projects/${project.id}/activity`)).json.items as { what: string; via: string }[];
  expect(rows.some((r) => r.via === "concierge")).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(marker);
});

test("AC4: Clear my chat deletes the thread, and the audit log records only that it was cleared", async ({ admin, later }) => {
  await requireConcierge(admin);
  await showConcierge(admin, later);
  const existing = await chatMessages(admin);
  test.skip(existing.length > 0, "This account's concierge chat already has messages. Clear my chat deletes the whole thread, so this test does not run against a chat it did not start.");
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us88-clear" });
  const r = await quickAction(admin, "due-week", project.id);
  expect(r.status, r.body).toBe(200);
  expect(JSON.stringify(await chatMessages(admin))).toContain(project.name);
  const p = admin.page;
  await p.goto("/");
  await p.locator("aside.cc-slot").getByRole("button", { name: "Clear my chat" }).click();
  const dialog = p.getByRole("dialog", { name: "Clear my chat?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Clear my chat" }).click();
  await expect(p.locator("aside.cc-slot").getByRole("button", { name: "Clear my chat" })).toHaveCount(0);
  expect(await chatMessages(admin)).toHaveLength(0);
  const audit = await admin.api.get("/api/audit?event=CHAT_CLEARED");
  expect(audit.status).toBe(200);
  const items = audit.json.items as { event: string }[];
  expect(items.some((i) => i.event === "CHAT_CLEARED")).toBe(true);
  expect(JSON.stringify(audit.json)).not.toContain(project.name);
});

test("AC5: the concierge states the privacy promise and does not claim privacy from database access", async ({ admin, later }) => {
  await requireConcierge(admin);
  await showConcierge(admin, later);
  const p = admin.page;
  await p.goto("/");
  const line = p.locator("aside.cc-slot .cc-privacy");
  await expect(line).toHaveText(PROMISE);
  const panel = (await p.locator("aside.cc-slot").innerText()).toLowerCase();
  expect(panel).not.toContain("database");
});
