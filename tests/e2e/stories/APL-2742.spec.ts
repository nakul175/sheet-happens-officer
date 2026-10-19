// APL-2742 (prod hotfix): sign up, ignore the email, sign out, sign in -> refused, with a resend link.
// A failed verification send is shown on the check-email screen with a resend option.
// Opening a verify link only shows "Verify my email"; the token is used on the click alone (mail link scanners open links).
// No screen sends a resend without a click. The verify and resend audit rows keep the client IP and user agent.
// Runs in `npm test` against the local test server (TASKBOARD_URL) and its outbox (EMAIL_OUTBOX_DIR), as in ci.yml.
// Anything but localhost is refused before a browser starts. nakul17+zztest accounts, ZZ-TEST names.
// QA gate: skipped without SHO_QA_PASS, which is also the accounts' password (ci.yml sets a CI-only value).
// Chromium: PW_CHROMIUM, else the system Chrome that GitHub's ubuntu-latest runner ships (as tests/inline-touch-2673.test.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { BASE, OUTBOX } from "../../helpers";
import { db } from "../../../src/lib/db";

const SHOTS = "test-results/apl-2742";
const run = Date.now();
let n = 0;
const fresh = () => `nakul17+zztest-apl2742-e2e-${run}-${n++}@aplyd.com`;

if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) {
  throw new Error(`Refusing to run against ${BASE}: this spec is local only.`);
}

const QA_PASS = process.env.SHO_QA_PASS ?? "";

let browser: Browser;

// What Caddy adds in production (X-Forwarded-For) and a recognisable browser user agent, so audit rows can be checked.
const CLIENT_IP = "203.0.113.42";
const CLIENT_UA = "ZZ-TEST-APL2742 Chromium";
const tracedContext = () => browser.newContext({ userAgent: CLIENT_UA, extraHTTPHeaders: { "x-forwarded-for": CLIENT_IP } });

/** Counts the page's requests to an API path from now on. */
function countRequests(page: Page, apiPath: string) {
  const seen = { n: 0 };
  page.on("request", (r) => { if (new URL(r.url()).pathname === apiPath) seen.n += 1; });
  return seen;
}

/**
 * Waits until the page is hydrated (its client control is enabled) and the network has been idle, so a request fired
 * on load would already have been seen.
 */
async function settle(page: Page, control: ReturnType<Page["getByRole"]>) {
  await control.waitFor({ state: "visible" });
  await page.waitForFunction(() => document.readyState === "complete");
  await expect.poll(() => control.isEnabled()).toBe(true);
  await page.waitForLoadState("networkidle");
}

function chromePath() {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("No Chrome/Chromium binary. Set PW_CHROMIUM.");
}

/** Verification links in the outbox for this address, oldest first. */
function verifyLinks(email: string): string[] {
  let files: string[] = [];
  try { files = readdirSync(OUTBOX).sort(); } catch { return []; }
  return files
    .map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8")) as { to: string; subject: string; text: string })
    .filter((m) => m.to === email && /Verify/.test(m.subject))
    .map((m) => m.text.match(/https?:\/\/\S+\/verify\?token=[\w-]+/)![0]);
}

async function signUp(page: Page, email: string) {
  await page.goto(`${BASE}/signup`);
  await page.fill("#name", "ZZ-TEST Unverified");
  await page.fill("#email", email);
  await page.fill("#password", QA_PASS);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/check-email/);
}

async function signIn(page: Page, email: string) {
  await page.goto(`${BASE}/signin`);
  await page.fill("#email", email);
  await page.fill("#password", QA_PASS);
  await page.click("button[type=submit]");
}

describe.skipIf(!QA_PASS)("qa:TC missing APL-2742: unverified sign-in and verification email", () => {
  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  it("qa:TC missing AC1: unverified user cannot sign in", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const email = fresh();
    await signUp(page, email);
    expect((await ctx.cookies()).find((c) => c.name === "sho_session"), "sign-up sets no session").toBeUndefined();

    // Ignore the email, sign out, then sign in with the sign-up password.
    expect((await page.request.post(`${BASE}/api/auth/signout`)).status()).toBe(204);
    await signIn(page, email);
    const alert = page.locator("main [role=alert]");
    await expect.poll(() => alert.textContent()).toMatch(/verify your email/i);
    expect(page.url()).toContain("/signin");
    expect((await ctx.cookies()).find((c) => c.name === "sho_session"), "refused sign-in sets no session").toBeUndefined();
    expect((await page.request.get(`${BASE}/api/auth/me`)).status()).toBe(401);
    await page.screenshot({ path: `${SHOTS}/refused.png` });

    // The app itself is closed to them.
    await page.goto(`${BASE}/`);
    await page.waitForURL(/\/signin/);
    await ctx.close();
  }, 60_000);

  it("qa:TC missing AC2: the refusal offers a resend that sends a new verification link", async () => {
    const ctx = await tracedContext();
    const page = await ctx.newPage();
    const email = fresh();
    await signUp(page, email);
    expect(verifyLinks(email)).toHaveLength(1);
    await signIn(page, email);
    await page.getByRole("button", { name: /resend/i }).click();
    await page.waitForURL(/\/check-email/);
    await expect.poll(() => verifyLinks(email).length).toBe(2);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const resend = await db.auditLog.findFirstOrThrow({ where: { actorId: user.id, event: "VERIFY_EMAIL_REQUESTED" } });
    expect(resend.ip).toBe(CLIENT_IP);
    expect(resend.data).toEqual({ result: "SENT", userAgent: CLIENT_UA });

    // The newest link, once its button is clicked, verifies the account; then the same password signs in.
    await page.goto(verifyLinks(email).at(-1)!);
    await page.getByRole("button", { name: "Verify my email" }).click();
    await expect.poll(() => page.locator("main").textContent()).toMatch(/verified/i);
    await signIn(page, email);
    await page.waitForURL((u) => !u.pathname.startsWith("/signin"));
    expect((await page.request.get(`${BASE}/api/auth/me`)).status()).toBe(200);
    await ctx.close();
  }, 60_000);

  it("qa:TC missing AC3: a failed verification send is shown with a resend option, not swallowed", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // The server answers this way when Resend rejects the send (tests/apl-2742.test.ts covers the server side).
    await page.route("**/api/auth/signup", (r) => r.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ status: "check_email", emailSent: false, message: "We created your account but could not send the verification email." }),
    }));
    const resends = countRequests(page, "/api/auth/resend-verification");
    await signUp(page, fresh());
    const alert = page.locator("main [role=alert]");
    await expect.poll(() => alert.textContent()).toMatch(/could not send the verification email/i);
    await page.screenshot({ path: `${SHOTS}/send-failed.png` });
    const resend = page.getByRole("button", { name: /resend the link/i });
    await settle(page, resend);
    expect(resends.n, "the failed-send screen sends nothing until Resend is clicked").toBe(0);
    expect(await alert.textContent(), "the message names the control as it is labelled").toContain('"resend the link"');

    // The server's resend answer is neutral (it never reveals a failed send); the screen never says the email went.
    await resend.click();
    await expect.poll(() => resends.n).toBe(1);
    const notice = page.locator("main [role=status]");
    await expect.poll(() => notice.textContent()).toMatch(/we are sending one/i);
    expect(await notice.textContent()).not.toMatch(/has been sent/i);
    await ctx.close();
  }, 60_000);

  it("qa:TC missing AC4: opening the verify link alone verifies nothing; the Verify my email click does, and is audited", async () => {
    const ctx: BrowserContext = await tracedContext();
    const page = await ctx.newPage();
    const email = fresh();
    await signUp(page, email);
    const verifies = countRequests(page, "/api/auth/verify");

    // What a mail link scanner does: open the link and let the page run, with no click.
    await page.goto(verifyLinks(email).at(-1)!);
    await settle(page, page.getByRole("button", { name: "Verify my email" }));
    expect(verifies.n, "loading /verify posts nothing").toBe(0);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).toBeNull();
    const token = await db.authToken.findFirstOrThrow({ where: { userId: user.id, type: "VERIFY" }, orderBy: { createdAt: "desc" } });
    expect(token.usedAt).toBeNull();
    await page.screenshot({ path: `${SHOTS}/verify-button.png` });

    // A person clicks.
    await page.getByRole("button", { name: "Verify my email" }).click();
    await expect.poll(() => page.locator("main").textContent()).toMatch(/email verified/i);
    expect(verifies.n).toBe(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerifiedAt).not.toBeNull();
    expect((await db.authToken.findUniqueOrThrow({ where: { id: token.id } })).usedAt).not.toBeNull();
    const row = await db.auditLog.findFirstOrThrow({ where: { actorId: user.id, event: "EMAIL_VERIFIED" } });
    expect(row.ip).toBe(CLIENT_IP);
    expect(row.data).toEqual({ userAgent: CLIENT_UA });
    await ctx.close();
  }, 60_000);

  it("qa:TC missing AC5: the sign-up success flow and /check-email never send a resend without a click", async () => {
    const ctx = await tracedContext();
    const page = await ctx.newPage();
    const resends = countRequests(page, "/api/auth/resend-verification");
    const email = fresh();
    const resend = page.getByRole("button", { name: /resend the link/i });
    await signUp(page, email);
    await settle(page, resend);
    await page.reload();
    await settle(page, resend);
    await page.goto(`${BASE}/check-email?failed=1`);
    await settle(page, resend);
    expect(resends.n, "no resend on sign-up, on /check-email or on its failed-send variant").toBe(0);
    expect(verifyLinks(email)).toHaveLength(1);

    await page.getByRole("button", { name: /resend/i }).click();
    await expect.poll(() => resends.n).toBe(1);
    await ctx.close();
  }, 60_000);
});
