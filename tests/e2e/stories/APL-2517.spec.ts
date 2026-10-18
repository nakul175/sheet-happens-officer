// SHO-US-8.8 Private chat history kept 90 days (APL-2517).
// One test per acceptance criterion. A quick action puts a line in the thread; no model call is made.
// AC2 cannot age a message or run the retention job. It reads the retention source (@static) and is not a live pass.
import { readFileSync } from "node:fs";
import { test, expect, zz } from "../support";
import { newProject, newTask } from "../g2";
import { chatMessages, cleanChat, quickAction } from "../helpers/jim-http";
import { dueIn, showConcierge, taskOf } from "../helpers/jim-concierge";
import { editTask } from "../helpers/claude-a";

test.describe.configure({ timeout: 90_000 });
test.use({ viewport: { width: 1440, height: 900 } });

// One skip for the whole file. The password is SHO_QA_PASS and is never generated here.
test.skip(!process.env.SHO_QA_PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");

const PROMISE = "Your chats are not visible anywhere in the app to anyone else, and are deleted from the app after 90 days.";
const read = (path: string) => readFileSync(path, "utf8");

test("AC1: no screen or endpoint returns another person's chat", async ({ admin, member, later }) => {
  await showConcierge(admin, later);
  await showConcierge(member, later);
  await cleanChat(member, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us88-private", members: [{ who: member, role: "EDITOR" }] });
  const sentence = `Due this week in ${project.name}`;
  const r = await quickAction(member, "due-week", project.id);
  expect(r.status, r.body).toBe(200);
  expect(r.body).toContain(sentence);
  const mine = await chatMessages(member);
  expect(JSON.stringify(mine)).toContain(sentence);
  const messageId = mine.at(-1)!.id;
  expect(JSON.stringify(await chatMessages(admin))).not.toContain(sentence);
  const asAdmin = await admin.page.context().request.fetch(`/api/concierge/choices/${messageId}`, {
    method: "POST", headers: { "content-type": "application/json" }, data: { choiceId: "none" },
  });
  expect(asAdmin.status()).toBe(404);
  expect(await asAdmin.text()).not.toContain(sentence);
  const listed = await admin.api.get(`/api/concierge/messages?userId=${member.user.id}`);
  expect(listed.status).not.toBe(200);
  expect(JSON.stringify(listed.json)).not.toContain(sentence);
  const audit = await admin.api.get("/api/audit");
  expect(JSON.stringify(audit.json)).not.toContain(sentence);
  await admin.page.goto("/");
  await expect(admin.page.locator("aside.cc-slot")).not.toContainText(sentence);
  expect(read("src/lib/concierge/thread.ts")).toContain("there is no function that reads another person's chat");
});

// @static: reading the retention source does not show that staging deleted a message.
test("AC2: a message older than 90 days is deleted by the retention job", { tag: "@static" }, async ({ admin }) => {
  const health = await admin.api.get("/api/health");
  expect(health.status).toBe(200);
  expect(health.json.ok).toBe(true);
  const jobs = await admin.api.get("/api/health/jobs");
  expect(jobs.status, "the job health page is the live signal that cron is running").toBe(200);
  const thread = read("src/lib/concierge/thread.ts");
  const jobsSrc = read("src/lib/jobs.ts");
  const release = read("deploy/release.sh");
  expect(thread).toContain("export const RETENTION_DAYS = 90");
  expect(thread).toContain("createdAt: { lt: cutoff }");
  expect(thread).toContain('event: "CHAT_PURGED"');
  expect(jobsSrc).toContain('name: "purge-chat"');
  expect(jobsSrc).toContain("purgeChat()");
  expect(release).toContain("install_cron purge-chat '47 3 * * *'");
});

test("AC3: a change made through chat is in the action log, and the chat text is not", async ({ admin, later }) => {
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const project = await newProject(admin, later, { label: "us88-log" });
  const title = zz("logged");
  const marker = zz("chat-only");
  const id = await newTask(admin, project.id, { title, assigneeId: admin.user.id, dueDate: dueIn(2) });
  const asked = await quickAction(admin, "due-week", project.id);
  expect(asked.status, asked.body).toBe(200);
  const edited = await editTask(admin, id, { dueDate: dueIn(6) });
  expect(edited.status, JSON.stringify(edited.json)).toBe(200);
  expect((await taskOf(admin, id)).dueDate).toBe(dueIn(6));
  const listed = await admin.api.get(`/api/projects/${project.id}/activity`);
  expect(listed.status).toBe(200);
  const rows = listed.json.items as { what: string; via: string }[];
  expect(rows.some((r) => r.via === "screen")).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(marker);
  expect(JSON.stringify(rows)).not.toContain("Due this week in");
  const cards = read("src/lib/concierge/cards.ts");
  expect(cards).toContain('channel: "CONCIERGE"');
  expect(read("src/lib/feed.ts")).toContain('via: r.channel === "CONCIERGE" ? "concierge" : "screen"');
  expect(cards).not.toContain("marker");
});

test("AC4: Clear my chat deletes the thread, and the audit log records only that it was cleared", async ({ admin, member, later }) => {
  await showConcierge(admin, later);
  await showConcierge(member, later);
  const who = (await chatMessages(admin)).length === 0 ? admin : (await chatMessages(member)).length === 0 ? member : null;
  expect(read("src/lib/concierge/thread.ts")).toContain('event: "CHAT_CLEARED"');
  expect(read("src/lib/concierge/thread.ts")).toContain("chatMessage.deleteMany");
  if (!who) {
    const before = await chatMessages(admin);
    await admin.page.goto("/");
    await admin.page.locator("aside.cc-slot").getByRole("button", { name: "Clear my chat" }).click();
    const dialog = admin.page.getByRole("dialog", { name: "Clear my chat?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("deletes your whole conversation");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(await chatMessages(admin)).toHaveLength(before.length);
    test.info().annotations.push({
      type: "kept",
      description: "Both staging chats already had messages, so Clear was opened and cancelled. Deleting them would remove a thread this run did not start.",
    });
    return;
  }
  await cleanChat(who, later);
  const project = await newProject(admin, later, { label: "us88-clear", ...(who === member ? { members: [{ who: member, role: "EDITOR" as const }] } : {}) });
  const r = await quickAction(who, "due-week", project.id);
  expect(r.status, r.body).toBe(200);
  expect(JSON.stringify(await chatMessages(who))).toContain(project.name);
  const p = who.page;
  await p.goto("/");
  await p.locator("aside.cc-slot").getByRole("button", { name: "Clear my chat" }).click();
  const dialog = p.getByRole("dialog", { name: "Clear my chat?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Clear my chat" }).click();
  await expect(p.locator("aside.cc-slot").getByRole("button", { name: "Clear my chat" })).toHaveCount(0);
  expect(await chatMessages(who)).toHaveLength(0);
  const audit = await admin.api.get("/api/audit?event=CHAT_CLEARED");
  expect(audit.status).toBe(200);
  const items = audit.json.items as { event: string }[];
  expect(items.some((i) => i.event === "CHAT_CLEARED")).toBe(true);
  expect(JSON.stringify(audit.json)).not.toContain(project.name);
});

test("AC5: the concierge states the privacy promise and does not claim privacy from database access", async ({ admin, later }) => {
  await showConcierge(admin, later);
  const p = admin.page;
  await p.goto("/");
  const line = p.locator("aside.cc-slot .cc-privacy");
  await expect(line).toHaveText(PROMISE);
  const panel = (await p.locator("aside.cc-slot").innerText()).toLowerCase();
  expect(panel).not.toContain("database");
  expect(read("src/lib/concierge/thread.ts")).toContain(PROMISE);
});
