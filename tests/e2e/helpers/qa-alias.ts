// Sign-in for story specs that use nakul17+ aliases. The password is SHO_QA_PASS and is never written here.
// A missing password skips the file from beforeAll. Every auth body is checked so the password is not echoed.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { APIRequestContext, Browser, BrowserContext } from "@playwright/test";
import { api, BASE_URL, expect, RUN, test, zz } from "../support";
import type { Who } from "../g2";

export const QA_PASS = process.env.SHO_QA_PASS ?? "";
/** Stable Super Admin address. The local server lists it in SUPER_ADMIN_EMAILS. */
export const QA_ADMIN_EMAIL = "nakul17+zz-sa@aplyd.com";
const OUTBOX = process.env.EMAIL_OUTBOX_DIR ?? ".outbox";

export function noSecret(body: string) {
  if (QA_PASS) expect(body.includes(QA_PASS)).toBe(false);
  const job = process.env.JOB_SECRET ?? "";
  if (job) expect(body.includes(job)).toBe(false);
}

/** nakul17+ alias on the signup domain. The label keeps the address readable in the Team list. */
export function qaEmail(label: string) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20);
  return `nakul17+${slug}-${RUN}@aplyd.com`;
}

/** First thing in the file: skip without SHO_QA_PASS, then read the release SHA from /api/health. */
export function gateFile() {
  test.beforeAll(async ({ playwright }) => {
    test.skip(!QA_PASS, "Set SHO_QA_PASS (the password for nakul17+ aliases).");
    const req = await playwright.request.newContext({ baseURL: BASE_URL });
    try { await assertRelease(req); }
    finally { await req.dispose(); }
  });
}

/** Release SHA from /api/health, checked before any account is used. */
export async function assertRelease(request: APIRequestContext) {
  const health = await request.get("/api/health");
  const body = await health.text();
  noSecret(body);
  expect(health.status(), body).toBe(200);
  const json = JSON.parse(body) as { ok?: boolean; release?: unknown };
  expect(json.ok).toBe(true);
  expect(typeof json.release === "string" && json.release.length >= 7, "the release SHA is reported").toBe(true);
  return json.release as string;
}

async function verifyToken(email: string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    let files: string[] = [];
    try { files = readdirSync(OUTBOX); } catch { files = []; }
    const mails = files.map((f) => {
      try { return JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8")) as { to?: string; subject?: string; text?: string }; }
      catch { return null; }
    }).filter((m): m is { to?: string; subject?: string; text?: string } => !!m && m.to === email && /Verify/.test(m.subject ?? ""));
    const token = mails.at(-1)?.text?.match(/token=([\w-]+)/)?.[1];
    if (token) return token;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/**
 * A signed-in nakul17+ person. Creates the account on first use (signup + the outbox verification link)
 * and signs in with SHO_QA_PASS after that. Register `ctx.close` with `later` before any other clean-up
 * so the context stays open while records are archived.
 */
export async function signInAlias(browser: Browser, email: string, name: string): Promise<{ who: Who; ctx: BrowserContext }> {
  if (!QA_PASS) throw new Error("Set SHO_QA_PASS (the password for nakul17+ aliases).");
  const ctx = await browser.newContext({ baseURL: BASE_URL });
  const sign = () => ctx.request.post("/api/auth/signin", { data: { email, password: QA_PASS } });
  let res = await sign();
  let text = await res.text();
  noSecret(text);
  if (res.status() !== 200) {
    const up = await ctx.request.post("/api/auth/signup", { data: { name, email, password: QA_PASS } });
    const upText = await up.text();
    noSecret(upText);
    expect(up.status(), upText).toBe(201);
    const token = await verifyToken(email);
    expect(token, `verification mail for ${email} in ${OUTBOX}`).toBeTruthy();
    const verified = await ctx.request.post("/api/auth/verify", { data: { token } });
    const verifiedText = await verified.text();
    noSecret(verifiedText);
    expect(verified.ok(), verifiedText).toBe(true);
    res = await sign();
    text = await res.text();
    noSecret(text);
  }
  expect(res.status(), text).toBe(200);
  const user = (JSON.parse(text) as { user: Record<string, unknown> }).user;
  const page = await ctx.newPage();
  return { who: { page, api: api(ctx.request), user }, ctx };
}

/** Close the context after the other clean-up. Call this immediately after sign-in, before any `later` that uses the session. */
export function track(later: (fn: () => Promise<unknown>) => void, ctx: BrowserContext) {
  later(() => ctx.close());
}

type Later = (fn: () => Promise<unknown>) => void;

/**
 * The Super Admin (nakul17+zz-sa) plus one signed-in nakul17+ person per label.
 * Each extra person is deactivated after the test. Register a leader hand-back before that if one of them leads a project.
 */
export async function cast(browser: Browser, later: Later, labels: string[]) {
  const admin = await signInAlias(browser, QA_ADMIN_EMAIL, "ZZ-TEST QA Admin");
  track(later, admin.ctx);
  expect(admin.who.user.orgRole, `${QA_ADMIN_EMAIL} must be listed in SUPER_ADMIN_EMAILS`).toBe("SUPER_ADMIN");
  const people: Who[] = [];
  for (const label of labels) {
    const signed = await signInAlias(browser, qaEmail(label), zz(label));
    track(later, signed.ctx);
    later(() => admin.who.api.post(`/api/team/${signed.who.user.id}/deactivate`, { reassign: "leaders" }));
    people.push(signed.who);
  }
  return { admin: admin.who, people };
}

/** POST /api/jobs/<name> on the local server. Refuses a remote host so a staging cron is never fired from here. */
export async function runLocalJob(name: string) {
  const secret = process.env.JOB_SECRET ?? "";
  const host = new URL(BASE_URL).hostname;
  const local = host === "localhost" || host === "127.0.0.1";
  test.skip(!local, "The scheduled job is not run against a remote host.");
  test.skip(secret.length < 16, "Set JOB_SECRET (16 characters or more) to run the scheduled job on the local server.");
  const res = await fetch(new URL(`/api/jobs/${name}`, BASE_URL), { method: "POST", headers: { authorization: `Bearer ${secret}` } });
  const text = await res.text();
  noSecret(text);
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as { job: string; status: string };
}
