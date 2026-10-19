// SHO-E8 Concierge (Linear APL-2472).
// One test per acceptance criterion. People are nakul17+ aliases signed in with SHO_QA_PASS.
// Questions that need the model skip when the concierge is off. Records are ZZ-TEST and archived afterwards.
// Pam left no qa:TC cases on this issue.
import { test, expect, zz } from "../support";
import { newProject, newTask, type Who } from "../g2";
import { cleanChat, quickAction } from "../helpers/jim-http";
import { ask, cardOf, dueIn, replyOf, requireModel, showConcierge } from "../helpers/jim-concierge";
import { QA_PASS, cast, gateFile, noSecret } from "../helpers/qa-alias";

gateFile();

test.use({ viewport: { width: 1440, height: 900 } });

test("AC1: a question is answered from data the member is allowed to see", async ({ browser, later }) => {
  const { admin, people: [member] } = await cast(browser, later, ["ask"]);
  await cleanChat(member, later);
  const mine = await newProject(admin, later, { label: "e8 mine", members: [{ who: member, role: "EDITOR" }] });
  const hidden = await newProject(admin, later, { label: "e8 hidden" });
  const visible = zz("visible due");
  const secret = zz("secret due");
  await newTask(member, mine.id, { title: visible, assigneeId: member.user.id, dueDate: dueIn(1) });
  await newTask(admin, hidden.id, { title: secret, assigneeId: admin.user.id, dueDate: dueIn(1) });
  const allowed = await quickAction(member, "due-week", mine.id);
  expect(allowed.status, allowed.body).toBe(200);
  expect(allowed.body).toContain(visible);
  expect(allowed.body.includes(QA_PASS)).toBe(false);
  const refused = await quickAction(member, "due-week", hidden.id);
  expect(refused.status).toBe(404);
  expect(refused.json.error).toBe("Project not found");
  expect(refused.body.includes(hidden.name)).toBe(false);
  expect(refused.body.includes(secret)).toBe(false);
});

test("AC2: a change is a confirm card and nothing is written until the member taps confirm", async ({ browser, later }) => {
  const { admin } = await cast(browser, later, []);
  await requireModel(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const p = await newProject(admin, later, { label: "e8 confirm" });
  const title = zz("confirm me");
  const id = await newTask(admin, p.id, { title, assigneeId: admin.user.id });
  const asked = await ask(admin, `Complete "${title}".`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  noSecret(JSON.stringify(asked.json));
  const card = cardOf(asked.messages);
  expect(card?.status).toBe("PENDING");
  expect(card?.canConfirm).toBe(true);
  expect((await admin.api.get(`/api/tasks/${id}`)).json.task.completedAt).toBeNull();
  const confirmed = await admin.api.post(`/api/concierge/cards/${card!.id}/confirm`, {});
  expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
  expect((await admin.api.get(`/api/tasks/${id}`)).json.task.completedAt).toBeTruthy();
});

test("AC3: two matching tasks produce one clarifying question and no guess", async ({ browser, later }) => {
  const { admin } = await cast(browser, later, []);
  await requireModel(admin);
  await cleanChat(admin, later);
  const p = await newProject(admin, later, { label: "e8 which" });
  const title = zz("budget");
  const first = await newTask(admin, p.id, { title, assigneeId: admin.user.id, dueDate: dueIn(1) });
  const second = await newTask(admin, p.id, { title, assigneeId: admin.user.id, dueDate: dueIn(4) });
  const asked = await ask(admin, `Move the "${title}" task to Monday.`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  expect(cardOf(asked.messages), "more than one match is not a card").toBeFalsy();
  const ids = (replyOf(asked.messages)?.choices ?? []).map((c) => c.id);
  expect(ids).toContain(first);
  expect(ids).toContain(second);
  expect((await admin.api.get(`/api/tasks/${first}`)).json.task.dueDate).toBe(dueIn(1));
  expect((await admin.api.get(`/api/tasks/${second}`)).json.task.dueDate).toBe(dueIn(4));
});

test("AC4: a vague prompt can be improved, and the member may accept or ignore the suggestion", async ({ browser, later }) => {
  const { admin } = await cast(browser, later, []);
  await requireModel(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const vague = "move that thing";
  const improved = await admin.api.post("/api/concierge/improve", { text: vague });
  expect(improved.status, JSON.stringify(improved.json)).toBe(200);
  noSecret(JSON.stringify(improved.json));
  const better = improved.json.improved as string;
  expect(better.length).toBeGreaterThan(0);
  const before = ((await admin.api.get("/api/concierge/state")).json.messages ?? []) as unknown[];
  expect(JSON.stringify(before).includes(better)).toBe(false);
  await admin.page.goto("/");
  const box = admin.page.locator("aside.cc-slot");
  await box.getByLabel("Message the concierge").fill(vague);
  await box.getByRole("button", { name: "Improve my prompt" }).click();
  const offer = box.getByRole("group", { name: "Suggested rewrite" });
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("Nothing has been sent.");
  await offer.getByRole("button", { name: "Keep mine" }).click();
  await expect(box.getByLabel("Message the concierge")).toHaveValue(vague);
  await box.getByRole("button", { name: "Improve my prompt" }).click();
  await expect(offer).toBeVisible();
  await offer.getByRole("button", { name: "Use it" }).click();
  await expect(box.getByLabel("Message the concierge")).not.toHaveValue(vague);
});

test("AC5: spoken English is transcribed into the composer and sent like typed text", async ({ browser, later }) => {
  const { admin } = await cast(browser, later, []);
  await requireModel(admin);
  await showConcierge(admin, later);
  await cleanChat(admin, later);
  const spoken = "What is due this week";
  await admin.page.addInitScript((line) => {
    class Fake {
      lang = "";
      continuous = false;
      interimResults = false;
      onresult: ((e: { resultIndex: number; results: { 0: { transcript: string }; isFinal: boolean; length: number }[] }) => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start() {
        setTimeout(() => {
          const row = { 0: { transcript: line }, isFinal: true, length: 1 };
          this.onresult?.({ resultIndex: 0, results: [row] });
          this.onend?.();
        }, 30);
      }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    const w = window as unknown as { SpeechRecognition: unknown; webkitSpeechRecognition: unknown };
    w.SpeechRecognition = Fake;
    w.webkitSpeechRecognition = Fake;
  }, spoken);
  await admin.page.goto("/");
  const box = admin.page.locator("aside.cc-slot");
  await box.getByRole("button", { name: "Dictate" }).click();
  const notice = box.getByRole("alertdialog", { name: "About dictation" });
  if (await notice.isVisible()) await notice.getByRole("button", { name: "Got it" }).click();
  await expect(box.getByLabel("Message the concierge")).toHaveValue(spoken);
  await box.getByRole("button", { name: "Send" }).click();
  await expect(box).toContainText(spoken);
  const messages = ((await admin.api.get("/api/concierge/state")).json.messages ?? []) as { role: string; text: string }[];
  expect(messages.some((m) => m.role === "USER" && m.text === spoken)).toBe(true);
  expect(messages.some((m) => m.role === "ASSISTANT" && m.text.length > 0)).toBe(true);
});

test("AC6: a member without permission is refused, as they would be on the screen", async ({ browser, later }) => {
  const { admin, people: [viewer] } = await cast(browser, later, ["viewer"]);
  await requireModel(viewer);
  await cleanChat(viewer, later);
  const p = await newProject(admin, later, { label: "e8 viewer", members: [{ who: viewer, role: "VIEWER" }] });
  const title = zz("viewer task");
  const due = dueIn(2);
  const id = await newTask(admin, p.id, { title, assigneeId: admin.user.id, dueDate: due });
  const screen = await viewer.api.post(`/api/tasks/${id}/complete`, {});
  expect(screen.status).toBe(403);
  const asked = await ask(viewer, `Complete "${title}".`);
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  const card = cardOf(asked.messages);
  expect(card, "the refusal is a card with no Confirm").toBeTruthy();
  expect(card!.canConfirm).toBe(false);
  expect(card!.blockedReason).toBeTruthy();
  expect((await admin.api.get(`/api/tasks/${id}`)).json.task.dueDate).toBe(due);
  expect((await admin.api.get(`/api/tasks/${id}`)).json.task.completedAt).toBeNull();
});

test("AC7: measured concierge spend for the month stays within the monthly cap", async ({ browser, later }) => {
  const { admin } = await cast(browser, later, []);
  const usage = await admin.api.get("/api/usage");
  expect(usage.status, JSON.stringify(usage.json)).toBe(200);
  const body = JSON.stringify(usage.json);
  expect(body.includes(QA_PASS)).toBe(false);
  const ceiling = usage.json.ceiling as { usd: number; spendUsd: number; percent: number };
  expect(ceiling.usd).toBeGreaterThan(0);
  expect(ceiling.spendUsd).toBeLessThanOrEqual(ceiling.usd);
  const month = usage.json.month as { messages: number; costUsd: number };
  if (month.messages > 0) expect(month.costUsd / month.messages).toBeLessThanOrEqual(ceiling.usd);
});
