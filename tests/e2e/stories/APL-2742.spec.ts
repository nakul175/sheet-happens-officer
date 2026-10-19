// APL-2742 (prod hotfix): sign up, ignore the email, sign out, sign in -> refused, with a resend link.
// A failed verification send is shown on the check-email screen with a resend option.
// Runs in `npm test` against the local test server (TASKBOARD_URL) and its outbox (EMAIL_OUTBOX_DIR), as in ci.yml.
// Anything but localhost is refused before a browser starts. nakul17+zztest accounts, ZZ-TEST names.
// Chromium: PW_CHROMIUM, else the system Chrome that GitHub's ubuntu-latest runner ships (as tests/inline-touch-2673.test.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { BASE, OUTBOX, PW } from "../../helpers";

const SHOTS = "test-results/apl-2742";
const run = Date.now();
let n = 0;
const fresh = () => `nakul17+zztest-apl2742-e2e-${run}-${n++}@aplyd.com`;

if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) {
  throw new Error(`Refusing to run against ${BASE}: this spec is local only.`);
}

let browser: Browser;

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
  await page.fill("#password", PW);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/check-email/);
}

async function signIn(page: Page, email: string) {
  await page.goto(`${BASE}/signin`);
  await page.fill("#email", email);
  await page.fill("#password", PW);
  await page.click("button[type=submit]");
}

beforeAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

describe("qa:TC missing APL-2742: unverified sign-in and verification email", () => {
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
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const email = fresh();
    await signUp(page, email);
    expect(verifyLinks(email)).toHaveLength(1);
    await signIn(page, email);
    await page.getByRole("button", { name: /resend/i }).click();
    await page.waitForURL(/\/check-email/);
    await expect.poll(() => verifyLinks(email).length).toBe(2);

    // The newest link verifies the account, and then the same password signs in.
    await page.goto(verifyLinks(email).at(-1)!);
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
    await page.route("**/api/auth/resend-verification", (r) => r.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "We could not send the email just now. Wait a few minutes, then try again." }),
    }));
    await signUp(page, fresh());
    const alert = page.locator("main [role=alert]");
    await expect.poll(() => alert.textContent()).toMatch(/could not send the verification email/i);
    await page.screenshot({ path: `${SHOTS}/send-failed.png` });

    await page.getByRole("button", { name: /resend/i }).click();
    await expect.poll(() => alert.textContent()).toMatch(/could not send the email just now/i);
    await expect.poll(() => page.locator("main [role=status]").count()).toBe(0);
    await ctx.close();
  }, 60_000);
});
