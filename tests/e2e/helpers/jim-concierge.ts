// Shared by the SHO-E8 / SHO-E9 story specs (APL-2510 to APL-2518).
// Each test clears the concierge thread it started empty (cleanChat) and does not continue another test's conversation,
// so these files are not in the staging workflow's SERIAL_SPECS. A thread that already held messages is left alone.
import { test, expect, login, BASE_URL, type Json } from "../support";
import { getTask, ymd, type Who } from "../g2";
import { conciergeLive, conciergeOff } from "./jim-gate";
import type { Browser, Page } from "@playwright/test";

type Later = (fn: () => Promise<unknown>) => void;

export type ConciergeMessage = {
  id: string;
  role: string;
  kind?: string;
  text: string;
  links?: { label: string; href: string }[];
  choices?: { id: string; label: string; detail?: string }[];
  choiceAnswered?: string;
  card?: {
    id: string;
    status: string;
    title: string;
    canConfirm: boolean;
    blockedReason?: string;
    irreversible?: boolean;
    changes?: { label: string; before?: string; after?: string }[];
    handover?: { taskId: string; taskTitle: string }[];
  };
  result?: {
    cardId: string;
    summary: string[];
    undoable: boolean;
    undoneAt?: string;
    undoExpired?: boolean;
    noticeSent?: boolean;
  };
};

/** Skip unless the concierge is switched on. A weekly cap or a provider pause still counts as on. */
export async function requireConcierge(who: Who) {
  const c = await conciergeLive(who);
  if (!c.live) test.info().annotations.push({ type: "skip", description: conciergeOff(c) });
  test.skip(!c.live, conciergeOff(c));
  return c;
}

/** Skip unless a model question can run. A cap or an outage pauses the composer and refuses the call. */
export async function requireModel(who: Who) {
  await requireConcierge(who);
  const s = await who.api.get("/api/concierge/state");
  const code = s.json.disabled?.code as string | undefined;
  test.skip(!!code, `The concierge cannot take a model question on this build (${code}: ${s.json.disabled?.message ?? "paused"}).`);
}

/** Puts the concierge back on screen for the test, and restores the account's hide preference afterwards. */
export async function showConcierge(who: Who, later: Later) {
  const was = !!(await who.api.get("/api/concierge/state")).json.hidden;
  if (was) expect((await who.api.patch("/api/concierge/preferences", { hidden: false })).status).toBe(200);
  later(() => who.api.patch("/api/concierge/preferences", { hidden: was }));
}

export async function postJson(who: Who, path: string, data?: unknown, timeout = 30_000) {
  const started = Date.now();
  const r = await who.page.context().request.fetch(path, {
    method: "POST",
    data,
    headers: { "content-type": "application/json" },
    timeout,
  });
  let json: Json = {};
  try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status(), json, ms: Date.now() - started };
}

/** One short prompt. The returned messages are this turn only. */
export async function ask(who: Who, text: string) {
  const r = await postJson(who, "/api/concierge/messages", { text }, 90_000);
  const messages = (Array.isArray(r.json.messages) ? r.json.messages : []) as ConciergeMessage[];
  return { ...r, messages };
}

export const replyOf = (messages: ConciergeMessage[]) => [...messages].reverse().find((m) => m.role === "ASSISTANT");
export const cardOf = (messages: ConciergeMessage[]) => [...messages].reverse().find((m) => m.card)?.card;

/** Messages this person has sent that counted toward the weekly cap. Quick actions do not. */
export async function weekCalls(who: Who) {
  const u = await who.api.get("/api/usage");
  expect(u.status, "usage is visible to the Super Admin").toBe(200);
  const people = (u.json.people ?? []) as { id: string; weekCalls?: number; weekMessages?: number }[];
  const row = people.find((p) => p.id === who.user.id);
  return row?.weekMessages ?? row?.weekCalls ?? 0;
}

const IST = 5.5 * 3600_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Next Monday after today in India time, printed as the confirm card prints a due date ("Monday 19 October 2026"). */
export function nextMondayFull(now = new Date()) {
  const x = new Date(now.getTime() + IST);
  const wd = x.getUTCDay();
  const add = ((1 - wd + 7) % 7) || 7;
  const target = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate() + add));
  return `${WEEKDAYS[target.getUTCDay()]} ${target.getUTCDate()} ${MONTHS[target.getUTCMonth()]} ${target.getUTCFullYear()}`;
}

/** A due date a few days out, as YYYY-MM-DD, inside "due this week" when `off` is 0 to 7. */
export const dueIn = (off: number) => ymd(off);

export async function taskOf(who: Who, id: string) {
  return getTask(who, id) as Promise<{ dueDate: string | null; priority: string; assignee: { id: string }; completedAt: string | null; title: string }>;
}

/** A second signed-in page on the same Admin account, the way another device would sign in. */
export async function secondScreen(browser: Browser, later: Later) {
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
  });
  later(() => ctx.close());
  const { email, password } = login("ADMIN");
  const r = await ctx.request.post("/api/auth/signin", { data: { email, password } });
  expect(r.ok(), `second sign-in as ${email}`).toBe(true);
  return ctx.newPage();
}

/** Installs a stand-in speech engine so a browser without SpeechRecognition can still exercise dictation. Call before goto. */
export async function armDictation(page: Page) {
  await page.addInitScript(`(() => {
    const bag = { mode: "hold", transcript: "ZZ-TEST dictate", lang: "" };
    window.__shoDict = bag;
    class Rec {
      constructor() { this.lang = ""; this.continuous = false; this.interimResults = false; this.onresult = null; this.onerror = null; this.onend = null; }
      start() {
        bag.lang = this.lang;
        const emit = () => { if (this.onresult) this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: bag.transcript }], { isFinal: true, length: 1 })] }); };
        const later = (fn) => setTimeout(fn, 0);
        if (bag.mode === "denied") { later(() => { if (this.onerror) this.onerror({ error: "not-allowed" }); if (this.onend) this.onend(); }); return; }
        if (bag.mode === "silence") { later(() => { emit(); if (this.onend) this.onend(); }); return; }
        if (bag.mode === "speak") emit();
      }
      stop() {
        if (bag.mode === "hold" && this.onresult) this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: bag.transcript }], { isFinal: true, length: 1 })] });
        if (this.onend) this.onend();
      }
      abort() { if (this.onend) this.onend(); }
    }
    window.SpeechRecognition = Rec;
    window.webkitSpeechRecognition = Rec;
  })();`);
}

export async function setDictation(page: Page, mode: "hold" | "speak" | "silence" | "denied", transcript = "ZZ-TEST dictate") {
  await page.evaluate(`(() => { const bag = window.__shoDict; if (bag) { bag.mode = ${JSON.stringify(mode)}; bag.transcript = ${JSON.stringify(transcript)}; } })()`);
}

/** Clicks the microphone, and accepts the first-use notice when this account has not seen it yet. */
export async function startDictation(who: Who) {
  const acked = !!(await who.api.get("/api/concierge/state")).json.voiceNoticeAcked;
  await who.page.locator("button.cc-mic").click();
  if (!acked) {
    const notice = who.page.getByRole("alertdialog", { name: "About dictation" });
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "Got it" }).click();
  }
}
