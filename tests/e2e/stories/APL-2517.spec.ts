import { dueBeforeNextMonday } from "../helpers/proposal-fixture-date";
// SHO-US-8.8 Private chat history kept 90 days (APL-2517).
// AC2 runs the actual retention job only on an explicitly owned local schema; remote targets fail closed.
// AC3 is the one model prompt: a confirmed change. The other checks use a quick action or the privacy line.
import { randomUUID } from "node:crypto";
import { test, expect, zz, BASE_URL } from "../support";
import { localPgPool, schemaFromDatabaseUrl } from "../helpers/local-db-pool";
import { alias, PASS, signUp, signInAs, waitForSinkMail } from "./qa";
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

test("AC2: a message older than 90 days is deleted by the retention job", async ({ admin }) => {
  const database = process.env.DATABASE_URL;
  const schema = database ? schemaFromDatabaseUrl(database) : undefined;
  expect(["localhost", "127.0.0.1"], "retention fixture requires a local app").toContain(new URL(BASE_URL).hostname);
  expect(schema, "Set a dedicated sho_2708_* local schema").toMatch(/^sho_[a-z0-9_]+$/);
  expect(process.env.SHO_OWNED_TEST_SCHEMA, "Explicit ownership must match DATABASE_URL schema").toBe(schema);
  const secret = process.env.JOB_SECRET;
  expect(secret?.length, "JOB_SECRET for the owned local app is required").toBeGreaterThanOrEqual(16);
  const pool = localPgPool(database);
  const ids = [randomUUID().replaceAll("-", ""), randomUUID().replaceAll("-", "")];
  try {
    const actor = await pool.query('SELECT email FROM "User" WHERE id=$1', [admin.user.id]);
    expect(actor.rows[0]?.email).toBe(admin.user.email);
    for (const [index, days] of [91, 89].entries()) {
      await pool.query('INSERT INTO "ChatMessage"(id,"userId",role,content,"createdAt") VALUES ($1,$2,$3,$4,$5)',
        [ids[index], admin.user.id, "USER", JSON.stringify({ kind: "text", text: zz(`retention-${days}`) }), new Date(Date.now() - days * 86400_000)]);
    }
    const before = await pool.query('SELECT id FROM "ChatMessage" WHERE id=ANY($1::text[]) AND "userId"=$2', [ids, admin.user.id]);
    expect(before.rowCount).toBe(2);
    const run = await admin.page.request.post("/api/jobs/purge-chat", { headers: { authorization: `Bearer ${secret}` } });
    expect(run.status()).toBe(200);
    expect((await run.json()).result).toBeGreaterThanOrEqual(1);
    const after = await pool.query('SELECT id FROM "ChatMessage" WHERE id=ANY($1::text[]) AND "userId"=$2', [ids, admin.user.id]);
    expect(after.rows.map((row) => row.id)).toEqual([ids[1]]);
    const visible = await chatMessages(admin);
    expect(visible.some((message) => message.id === ids[0])).toBe(false);
    expect(visible.some((message) => message.id === ids[1])).toBe(true);
    test.info().annotations.push({ type: "evidence-scope", description: "Actual purge-chat HTTP job and database boundary on an owned local schema; not a staging receipt." });
  } finally {
    await pool.query('DELETE FROM "ChatMessage" WHERE id=ANY($1::text[]) AND "userId"=$2', [ids, admin.user.id]);
    await pool.end();
  }
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

test("AC4: Clear my chat deletes the thread, and the audit log records only that it was cleared", async ({ admin, browser, request, later }) => {
  // A fresh verified account owns this entire thread. Never erase a shared admin's pre-existing chat.
  expect(PASS, "SHO_QA_PASS must be supplied at runtime").toBeTruthy();
  const email = alias("2517", "clear", "aplyd.com");
  const signup = await signUp(request, zz("owned-clear-chat"), email);
  expect(signup.status, signup.body).toBe(201);
  const mail = await waitForSinkMail(email, "Verify");
  const verified = await request.post("/api/auth/verify", { data: { token: mail.token } });
  expect(verified.status()).toBe(200);
  const owner = await signInAs(browser, email, PASS);
  later(() => owner.ctx.close());
  later(async () => { expect((await admin.api.post(`/api/team/${owner.user.id}/deactivate`, { reassign: "leaders" })).status).toBe(200); });
  await showConcierge(owner, later);
  expect(await chatMessages(owner), "new account's thread starts empty").toHaveLength(0);
  await cleanChat(owner, later);
  const project = await newProject(admin, later, { label: "us88-clear", members: [{ who: owner, role: "EDITOR" }] });
  const r = await quickAction(owner, "due-week", project.id);
  expect(r.status, r.body).toBe(200);
  expect(JSON.stringify(await chatMessages(owner))).toContain(project.name);
  const p = owner.page;
  await p.goto("/");
  await p.locator("aside.cc-slot").getByRole("button", { name: "Clear my chat" }).click();
  const dialog = p.getByRole("dialog", { name: "Clear my chat?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Clear my chat" }).click();
  await expect(p.locator("aside.cc-slot").getByRole("button", { name: "Clear my chat" })).toHaveCount(0);
  expect(await chatMessages(owner)).toHaveLength(0);
  const audit = await admin.api.get(`/api/audit?event=CHAT_CLEARED&person=${owner.user.id}`);
  expect(audit.status).toBe(200);
  const items = audit.json.items as { event: string }[];
  expect(items.filter((i) => i.event === "CHAT_CLEARED")).toHaveLength(1);
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
