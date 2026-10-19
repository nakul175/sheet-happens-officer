// APL-2742 (prod hotfix): sign up, ignore the email, sign out, sign in -> refused, with a resend link.
// Opening a verify link only shows "Verify my email"; the token is used on the click alone (mail link scanners open links).
// No screen sends a resend without a click. The verify and resend audit rows keep the client IP and user agent.
// On the failure paths (send refused, limit, unusable link) every screen tells the truth: nothing says an email went.
//
// QA gate: skipped without SHO_QA_PASS, which is also the accounts' password. CI does not set it, so CI skips this file.
// Servers: the spec starts its own two `next start` processes from the existing build (`npm run build` first), on
// 127.0.0.1 only, against the local database (anything else in DATABASE_URL is refused):
//   mail-ok      writes mail to a temp outbox this spec creates and removes in afterAll;
//   mail-failing has no RESEND_API_KEY and no outbox, so every send fails as it does in production today.
// The outbox is read for the newest "Verify your email" mail to the exact address only; no token or mail body is logged.
// ZZ-TEST names, nakul17+zztest aliases; every account made here is deactivated through the API in afterAll.
// Chromium: PW_CHROMIUM, else the system Chrome that GitHub's ubuntu-latest runner ships (as tests/inline-touch-2673.test.ts).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { db } from "../../../src/lib/db";

const QA_PASS = process.env.SHO_QA_PASS ?? "";
const PORT = Number(process.env.APL2742_PORT ?? 3142);
const OK = `http://127.0.0.1:${PORT}`;
const FAILING = `http://127.0.0.1:${PORT + 1}`;
for (const base of [OK, FAILING]) {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(base).hostname)) throw new Error(`Refusing to run against ${base}: this spec is local only.`);
}

const SHOTS = "test-results/apl-2742";
const ROOT_EMAIL = "nakul17+zztest-apl2742-root@aplyd.com"; // Super Admin on the spec's servers, used for clean-up only
const VERIFY_SUBJECT = "Verify your email for Sheet Happens Officer";
const run = Date.now();
let n = 0;
const created: string[] = [];
const fresh = () => {
  const email = `nakul17+zztest-apl2742-e2e-${run}-${n++}@aplyd.com`;
  created.push(email);
  return email;
};

// APL-2742 D1 (QA): the exact texts on the failure paths.
const UNVERIFIED_TEXT = "Verify your email before you sign in. No working verification link? Use Resend link.";
const RESEND_TEXT = "Request received. If this address has an account waiting for verification, and it has not reached the limit of 3 requests an hour, we will try to email it a new link. If nothing arrives within a few minutes, check spam, then try again later.";
const SEND_FAILED_TEXT = 'We created your account but could not send the verification email. Use "resend the link" below in a few minutes; if it still does not arrive, contact your Super Admin.';
const UNUSABLE_HEADING = "This link can't be used";
const UNUSABLE_LEAD = "It may have expired, been used already or been replaced by a newer link. If you already used it, sign in. Otherwise, ask for a new link below.";
const WE_SENT = "We sent a verification link";

// What Caddy adds in production (X-Forwarded-For) and a recognisable browser user agent, so audit rows can be checked.
const CLIENT_IP = "203.0.113.42";
const CLIENT_UA = "ZZ-TEST-APL2742 Chromium";

let browser: Browser;
let outbox = "";
const servers: ChildProcess[] = [];
const tracedContext = () => browser.newContext({ userAgent: CLIENT_UA, extraHTTPHeaders: { "x-forwarded-for": CLIENT_IP } });

function chromePath() {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("No Chrome/Chromium binary. Set PW_CHROMIUM.");
}

async function healthStatus(base: string) {
  try {
    return (await fetch(`${base}/api/health`)).status;
  } catch {
    return 0;
  }
}

/** Starts `next start` on the base's port with the given mail settings, and waits until /api/health answers 200. */
async function startServer(base: string, mail: Record<string, string>) {
  if ((await healthStatus(base)) !== 0) throw new Error(`Something already answers on ${base}; set APL2742_PORT to a free port.`);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", APP_URL: base, SUPER_ADMIN_EMAILS: ROOT_EMAIL, ...mail };
  delete env.RESEND_API_KEY; // never a real send from this spec
  if (!mail.EMAIL_OUTBOX_DIR) delete env.EMAIL_OUTBOX_DIR;
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", new URL(base).port, "-H", "127.0.0.1"], { env, stdio: "ignore" });
  servers.push(child);
  // A condition wait (hooks cannot use expect.poll): health must answer 200 before the deadline.
  const deadline = Date.now() + 90_000;
  while ((await healthStatus(base)) !== 200) {
    if (child.exitCode !== null) throw new Error(`next start for ${base} exited (${child.exitCode}).`);
    if (Date.now() > deadline) throw new Error(`next start for ${base} did not become healthy in 90 s.`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** A small JSON client for the spec's own servers (clean-up and the Super Admin sign-in). */
async function call(base: string, method: string, p: string, body?: unknown, cookie = "") {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get("set-cookie");
  const text = await res.text();
  return { status: res.status, json: text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null, cookie: set ? set.split(";")[0] : "" };
}

type Mail = { to: string; subject: string; text: string };

/** "Verify your email" mails to exactly this address in the spec's outbox, oldest first (files are named by send time). */
function verifyMails(email: string): Mail[] {
  let files: string[] = [];
  try { files = readdirSync(outbox).sort(); } catch { return []; }
  return files
    .map((f) => JSON.parse(readFileSync(path.join(outbox, f), "utf8")) as Mail)
    .filter((m) => m.to === email && m.subject === VERIFY_SUBJECT);
}
const verifyCount = (email: string) => verifyMails(email).length;

/** The link in the newest verification mail to this address. Errors never include the link or the mail. */
function newestVerifyLink(email: string): string {
  const link = verifyMails(email).at(-1)?.text.match(/https?:\/\/\S+\/verify\?token=[\w-]+/)?.[0];
  if (!link) throw new Error("No verification link was mailed to this address.");
  return link;
}

async function openVerifyLink(page: Page, link: string) {
  try {
    await page.goto(link);
  } catch {
    throw new Error("Opening the verification link failed."); // the link carries a token: never in an error
  }
}

/** Counts the page's requests to an API path from now on. */
function countRequests(page: Page, apiPath: string) {
  const seen = { n: 0 };
  page.on("request", (r) => { if (new URL(r.url()).pathname === apiPath) seen.n += 1; });
  return seen;
}

/** Waits until the page is hydrated (its control is enabled) and the network is idle, so a request fired on load was seen. */
async function settle(page: Page, control: ReturnType<Page["getByRole"]>) {
  await control.waitFor({ state: "visible" });
  await page.waitForFunction(() => document.readyState === "complete");
  await expect.poll(() => control.isEnabled()).toBe(true);
  await page.waitForLoadState("networkidle");
}

const main = (page: Page) => page.getByRole("main");

async function signUp(page: Page, base: string, email: string) {
  await page.goto(`${base}/signup`);
  await page.getByLabel("Full name").fill("ZZ-TEST Unverified");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(QA_PASS);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/check-email/);
}

async function signIn(page: Page, base: string, email: string) {
  await page.goto(`${base}/signin`);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(QA_PASS);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

const userId = async (email: string) => (await db.user.findUniqueOrThrow({ where: { email } })).id;
const resendResults = async (email: string) =>
  (await db.auditLog.findMany({ where: { actorId: await userId(email), event: "VERIFY_EMAIL_REQUESTED" }, orderBy: { createdAt: "asc" } }))
    .map((r) => (r.data as { result: string }).result);

describe.skipIf(!QA_PASS)("qa:TC missing APL-2742: unverified sign-in and verification email", () => {
  beforeAll(async () => {
    const dbHost = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : "";
    if (!/^(localhost|127\.0\.0\.1)$/.test(dbHost)) throw new Error("Refusing to run: DATABASE_URL must point at a local database.");
    if (!existsSync(".next/BUILD_ID")) throw new Error("Run `npm run build` first: this spec starts its own `next start`.");
    mkdirSync(SHOTS, { recursive: true });
    outbox = mkdtempSync(path.join(os.tmpdir(), "apl2742-outbox-"));
    await startServer(OK, { EMAIL_OUTBOX_DIR: outbox });
    await startServer(FAILING, {});
    browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  }, 240_000);

  afterAll(async () => {
    const problems: string[] = [];
    try {
      // Clean-up through the API: the Super Admin alias deactivates every account this run made.
      if ((await call(OK, "POST", "/api/auth/signup", { name: "ZZ-TEST Root", email: ROOT_EMAIL, password: QA_PASS })).status === 201) {
        const verified = await call(OK, "POST", "/api/auth/verify", { token: newestVerifyLink(ROOT_EMAIL).split("token=")[1] });
        if (verified.status !== 200) problems.push(`verify the clean-up account: ${verified.status}`);
      }
      const root = await call(OK, "POST", "/api/auth/signin", { email: ROOT_EMAIL, password: QA_PASS });
      if (root.status !== 200) problems.push(`sign in the clean-up account: ${root.status}`);
      for (const email of root.status === 200 ? created : []) {
        const who = await db.user.findUnique({ where: { email } });
        if (!who) continue;
        const off = await call(OK, "POST", `/api/team/${who.id}/deactivate`, { reassign: "leaders" }, root.cookie);
        if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) problems.push(`deactivate an account: ${off.status}`);
      }
    } finally {
      await browser?.close();
      for (const s of servers) s.kill("SIGTERM"); // exactly the processes this spec started
      if (outbox) rmSync(outbox, { recursive: true, force: true });
    }
    expect(problems, "clean-up").toEqual([]);
  }, 120_000);

  it("qa:TC missing AC1: unverified user cannot sign in, and the refusal does not assume an email arrived", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const email = fresh();
    await signUp(page, OK, email);
    expect((await ctx.cookies()).find((c) => c.name === "sho_session"), "sign-up sets no session").toBeUndefined();

    // Ignore the email, sign out, then sign in with the sign-up password.
    expect((await page.request.post(`${OK}/api/auth/signout`)).status()).toBe(204);
    await signIn(page, OK, email);
    const alert = main(page).getByRole("alert");
    await expect.poll(() => alert.getByText(UNVERIFIED_TEXT, { exact: true }).count()).toBe(1);
    expect(await alert.getByRole("button", { name: "Resend link" }).count()).toBe(1);
    expect(new URL(page.url()).pathname).toBe("/signin");
    expect((await ctx.cookies()).find((c) => c.name === "sho_session"), "refused sign-in sets no session").toBeUndefined();
    expect((await page.request.get(`${OK}/api/auth/me`)).status()).toBe(401);
    await page.screenshot({ path: `${SHOTS}/refused.png` });

    // The app itself is closed to them.
    await page.goto(`${OK}/`);
    await page.waitForURL(/\/signin/);
    await ctx.close();
  }, 60_000);

  it("qa:TC missing AC2: the refusal's resend sends a new link, is audited, lands on the neutral screen, and the click verifies", async () => {
    const ctx = await tracedContext();
    const page = await ctx.newPage();
    const email = fresh();
    await signUp(page, OK, email);
    expect(verifyCount(email)).toBe(1);
    await signIn(page, OK, email);
    await main(page).getByRole("button", { name: "Resend link" }).click();
    await page.waitForURL(/\/check-email\?resent=1$/);
    await expect.poll(() => main(page).getByRole("status").textContent()).toBe(RESEND_TEXT);
    expect(await main(page).getByText(WE_SENT).count(), "never 'We sent' after a resend").toBe(0);
    await expect.poll(() => verifyCount(email)).toBe(2);
    const resend = await db.auditLog.findFirstOrThrow({ where: { actorId: await userId(email), event: "VERIFY_EMAIL_REQUESTED" } });
    expect(resend.ip).toBe(CLIENT_IP);
    expect(resend.data).toEqual({ result: "SENT", userAgent: CLIENT_UA });

    // The newest link, once its button is clicked, verifies the account; then the same password signs in.
    await openVerifyLink(page, newestVerifyLink(email));
    await main(page).getByRole("button", { name: "Verify my email" }).click();
    await expect.poll(() => main(page).getByRole("heading", { name: "Email verified" }).count()).toBe(1);
    await signIn(page, OK, email);
    await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
    expect((await page.request.get(`${OK}/api/auth/me`)).status()).toBe(200);
    await ctx.close();
  }, 60_000);

  it("qa:TC missing AC3: when sending fails, sign-up says so with the exact text, and its resend shows only the neutral notice", async () => {
    const ctx = await tracedContext();
    const page = await ctx.newPage();
    const resends = countRequests(page, "/api/auth/resend-verification");
    const email = fresh();
    await signUp(page, FAILING, email);
    expect(new URL(page.url()).search).toBe("?failed=1");
    const alert = main(page).getByRole("alert");
    await expect.poll(() => alert.textContent()).toBe(SEND_FAILED_TEXT);
    expect(await main(page).getByText(WE_SENT).count()).toBe(0);
    await page.screenshot({ path: `${SHOTS}/send-failed.png` });
    const resend = main(page).getByRole("button", { name: "resend the link" });
    await settle(page, resend);
    expect(resends.n, "the failed-send screen sends nothing until it is clicked").toBe(0);

    await resend.click();
    await expect.poll(() => resends.n).toBe(1);
    await expect.poll(() => main(page).getByRole("status").textContent()).toBe(RESEND_TEXT);
    expect(await resendResults(email)).toEqual(["FAILED"]);
    await ctx.close();
  }, 60_000);

  it("qa:TC missing AC6: when sending fails, Resend link from the sign-in refusal shows the exact neutral text, never 'We sent'", async () => {
    // QA D1: the sign-in refusal's resend used to land on /check-email saying "We sent a verification link".
    const ctx = await tracedContext();
    const page = await ctx.newPage();
    const email = fresh();
    await signUp(page, FAILING, email);
    expect((await page.request.post(`${FAILING}/api/auth/signout`)).status()).toBe(204);
    await signIn(page, FAILING, email);
    await expect.poll(() => main(page).getByRole("alert").getByText(UNVERIFIED_TEXT, { exact: true }).count()).toBe(1);
    await main(page).getByRole("button", { name: "Resend link" }).click();
    await page.waitForURL(/\/check-email\?resent=1$/);
    await expect.poll(() => main(page).getByRole("status").textContent()).toBe(RESEND_TEXT);
    expect(await main(page).getByText(WE_SENT).count(), "the failed resend is never reported as sent").toBe(0);
    await expect.poll(() => resendResults(email)).toEqual(["FAILED"]);
    await page.screenshot({ path: `${SHOTS}/resent-failed.png` });
    await ctx.close();
  }, 60_000);

  it("qa:TC missing AC7: an unusable verify link leads to the exact can't-be-used text, and its resend to the neutral notice", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const email = fresh();
    await signUp(page, OK, email);
    await page.goto(`${OK}/verify?token=${"z".repeat(43)}`);
    await main(page).getByRole("button", { name: "Verify my email" }).click();
    await page.waitForURL(/\/expired$/);
    expect(await main(page).getByRole("heading", { level: 1 }).textContent()).toBe(UNUSABLE_HEADING);
    expect(await main(page).getByText(UNUSABLE_LEAD, { exact: true }).count()).toBe(1);
    await main(page).getByRole("button", { name: "Send a new verification link" }).click();
    await page.waitForURL(/\/check-email\?resent=1$/);
    await expect.poll(() => main(page).getByRole("status").textContent()).toBe(RESEND_TEXT);
    expect(await main(page).getByText(WE_SENT).count()).toBe(0);
    await ctx.close();
  }, 60_000);

  it("qa:TC missing AC4: opening the verify link alone verifies nothing; the Verify my email click does, and is audited", async () => {
    const ctx = await tracedContext();
    const page = await ctx.newPage();
    const email = fresh();
    await signUp(page, OK, email);
    const verifies = countRequests(page, "/api/auth/verify");

    // What a mail link scanner does: open the link and let the page run, with no click.
    await openVerifyLink(page, newestVerifyLink(email));
    await settle(page, main(page).getByRole("button", { name: "Verify my email" }));
    expect(verifies.n, "loading /verify posts nothing").toBe(0);
    const id = await userId(email);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).emailVerifiedAt).toBeNull();
    const token = await db.authToken.findFirstOrThrow({ where: { userId: id, type: "VERIFY" }, orderBy: { createdAt: "desc" } });
    expect(token.usedAt).toBeNull();
    await page.screenshot({ path: `${SHOTS}/verify-button.png` });

    // A person clicks.
    await main(page).getByRole("button", { name: "Verify my email" }).click();
    await expect.poll(() => main(page).getByRole("heading", { name: "Email verified" }).count()).toBe(1);
    expect(verifies.n).toBe(1);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).emailVerifiedAt).not.toBeNull();
    expect((await db.authToken.findUniqueOrThrow({ where: { id: token.id } })).usedAt).not.toBeNull();
    const row = await db.auditLog.findFirstOrThrow({ where: { actorId: id, event: "EMAIL_VERIFIED" } });
    expect(row.ip).toBe(CLIENT_IP);
    expect(row.data).toEqual({ userAgent: CLIENT_UA });
    await ctx.close();
  }, 60_000);

  it("qa:TC missing AC5: sign-up, /check-email and its failed and resent variants never send a resend without a click", async () => {
    const ctx = await tracedContext();
    const page = await ctx.newPage();
    const resends = countRequests(page, "/api/auth/resend-verification");
    const email = fresh();
    const resend = main(page).getByRole("button", { name: "resend the link" });
    await signUp(page, OK, email);
    await settle(page, resend);
    await page.reload();
    await settle(page, resend);
    for (const variant of ["?failed=1", "?resent=1"]) {
      await page.goto(`${OK}/check-email${variant}`);
      await settle(page, resend);
    }
    expect(resends.n, "no resend on sign-up, on /check-email or on its variants").toBe(0);
    expect(verifyCount(email)).toBe(1);

    await resend.click();
    await expect.poll(() => resends.n).toBe(1);
    await ctx.close();
  }, 60_000);
});
