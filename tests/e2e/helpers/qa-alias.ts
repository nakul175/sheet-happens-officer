// Sign-in for story specs that use nakul17+ aliases (APL-2748). The people are a fixed, already verified pool
// (helpers/alias-pool.ts): nothing here signs up or verifies an account. Oscar provisions the pool once with
// tests/e2e/tools/provision-aliases.ts. The password is SHO_QA_PASS and is never written here.
// A missing password skips the file from beforeAll. Every auth body is checked so the password is not echoed.
import type { APIRequestContext, Browser, BrowserContext } from "@playwright/test";
import { api, BASE_URL, expect, test } from "../support";
import type { Who } from "../g2";
import { PER_SLOT, QA_ADMIN_EMAIL, poolPerson, slotFromEnv } from "./alias-pool";

export { QA_ADMIN_EMAIL };
export const QA_PASS = process.env.SHO_QA_PASS ?? "";
/** This job's slot of the pool: QA_SLOT (01-20 or serial in CI), else local. */
export const QA_SLOT = slotFromEnv(process.env);
const PROVISION = "Run tests/e2e/tools/provision-aliases.ts (see its header) so the alias exists, is verified and uses SHO_QA_PASS.";

const httpCredentials = () =>
  process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined;

export function noSecret(body: string) {
  if (QA_PASS) expect(body.includes(QA_PASS)).toBe(false);
  const job = process.env.JOB_SECRET ?? "";
  if (job) expect(body.includes(job)).toBe(false);
}

/** Pool Member `index` (1-based) of this job's slot. */
export function qaPerson(index: number) {
  return poolPerson(QA_SLOT, index);
}

/** First thing in the file: skip without SHO_QA_PASS, then read the release SHA from /api/health. */
export function gateFile() {
  test.beforeAll(async ({ playwright }) => {
    test.skip(!QA_PASS, "Set SHO_QA_PASS (the password for nakul17+ aliases).");
    const req = await playwright.request.newContext({ baseURL: BASE_URL, httpCredentials: httpCredentials() });
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

/**
 * A signed-in pool alias. Sign-in only: an alias that is missing, unverified or deactivated fails with the
 * provisioning step to run, and is never created here. Register `ctx.close` with `later` before any other
 * clean-up so the context stays open while records are archived.
 */
export async function signInAlias(browser: Browser, email: string): Promise<{ who: Who; ctx: BrowserContext }> {
  if (!QA_PASS) throw new Error("Set SHO_QA_PASS (the password for nakul17+ aliases).");
  const ctx = await browser.newContext({ baseURL: BASE_URL, httpCredentials: httpCredentials() });
  const res = await ctx.request.post("/api/auth/signin", { data: { email, password: QA_PASS } });
  const text = await res.text();
  noSecret(text);
  if (res.status() !== 200) {
    await ctx.close();
    throw new Error(`Sign-in for pool alias ${email} returned ${res.status()}. ${PROVISION}`);
  }
  const user = (JSON.parse(text) as { user: Record<string, unknown> }).user;
  const page = await ctx.newPage();
  return { who: { page, api: api(ctx.request), user }, ctx };
}

/** Close the context after the other clean-up. Call this immediately after sign-in, before any `later` that uses the session. */
export function track(later: (fn: () => Promise<unknown>) => void, ctx: BrowserContext) {
  later(() => ctx.close());
}

type Later = (fn: () => Promise<unknown>) => void;

/** A pool Member a spec promoted goes back to Member, so the next spec (or run) gets the role it expects. */
async function demote(admin: Who, person: Who) {
  const seen = await admin.api.get(`/api/team/${person.user.id}`);
  if (seen.status === 200 && seen.json.person?.orgRole !== "MEMBER") {
    const back = await admin.api.patch(`/api/team/${person.user.id}`, { orgRole: "MEMBER" });
    expect(back.status, `put ${String(person.user.email)} back to Member`).toBe(200);
  }
  person.user.orgRole = "MEMBER";
}

/**
 * The Super Admin (nakul17+zz-sa) plus one pool Member per label, from this job's slot. The labels say what each
 * person is for; the accounts are fixed. Each one is a Member when handed out and is put back to Member after the
 * test, never deactivated, because the pool is reused.
 */
export async function cast(browser: Browser, later: Later, labels: string[]) {
  if (labels.length > PER_SLOT) throw new Error(`cast asks for ${labels.length} people; a pool slot has ${PER_SLOT}.`);
  const admin = await signInAlias(browser, QA_ADMIN_EMAIL);
  track(later, admin.ctx);
  expect(admin.who.user.orgRole, `${QA_ADMIN_EMAIL} must be listed in SUPER_ADMIN_EMAILS`).toBe("SUPER_ADMIN");
  const people: Who[] = [];
  for (let i = 0; i < labels.length; i++) {
    const signed = await signInAlias(browser, qaPerson(i + 1).email);
    track(later, signed.ctx);
    if (signed.who.user.orgRole !== "MEMBER") await demote(admin.who, signed.who);
    later(() => demote(admin.who, signed.who));
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
