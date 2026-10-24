// APL-2624 story spec (SHO-US-23.5): a Super-Admin-issued password must be changed at first sign-in.
// AC8 is the sign-in answer's mustChangePassword (from APL-2715, closed as a duplicate).
// No TC id is written on the issue, so every describe and test title carries qa:TC missing.
// workers=1: the cases in this file run one after another, and the suite runs one file at a time.
// Local mode reads EMAIL_OUTBOX_DIR; isolated slot9 reads the authenticated staging mailbox.
// Missing credentials fail, and production targets are refused.
// Thrown-away people use ZZ-TEST names and nakul17+zz-…@aplyd.com aliases; afterAll deactivates them.
// Playwright (APL-2911): the fixture helper has no Vitest imports and supports local CI or slot9.
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { signInDetailsMail } from "@/lib/email";
import { account, BASE, Client, PW, ADMIN_PW, superAdmin, mailText, browserCredentials, requirePasswordFixture, type Account } from "../password-fixture";

const WALL = "Set your own password";
const REPLACE = "The person must replace it with their own when they first sign in.";
const REFUSED = "Choose a new password. It cannot be the one we emailed you.";
const WRONG = "Email or password is incorrect.";
const NEW_PW = "my-own-pass-7";
const SCREENS = ["/", "/projects", "/team", "/profile", "/search"];
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;
let browser: Browser;
let admin: Account;
const created: string[] = [];

const emailedPassword = async (email: string, previous?: string) =>
  (await mailText(email, /Your Sheet Happens Officer account/, previous)).match(/Password: (\S+)/)?.[1] ?? "";
const resetToken = async (email: string) =>
  (await mailText(email, /Reset your Sheet Happens Officer password/)).match(/token=([\w-]+)/)?.[1] ?? "";

/** A ZZ-TEST person added by the Super Admin. Returns the emailed password. */
async function issued() {
  const tag = `${RUN}-${seq++}`;
  const email = `nakul17+zz-2624-e2e-${tag}@aplyd.com`;
  const r = await admin.c.post("/api/team", { firstName: "ZZ-TEST", lastName: `Forced${tag}`, email, role: "MEMBER" });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  created.push(r.json.person.id as string);
  const password = await emailedPassword(email);
  expect(password).toMatch(/^[A-Za-z0-9]{12}$/);
  return { email, password, id: r.json.person.id as string };
}

/** A ZZ-TEST person who signed up with their own password. */
async function ownPassword() {
  const tag = `${RUN}-${seq++}`;
  const who = await account(`ZZ-TEST own ${tag}`, `nakul17+zz-2624-e2e-own-${tag}@aplyd.com`);
  created.push(who.id);
  return who;
}

async function openPage() {
  return (await browser.newContext({ baseURL: BASE, httpCredentials: browserCredentials })).newPage();
}

/**
 * Fills the sign-in form. Returns the JSON the form got from POST /api/auth/signin.
 * On success it waits for the redirect, so a following goto does not abort the request that sets the cookie.
 */
async function signIn(page: Page, email: string, password: string, ok = true) {
  await page.goto("/signin");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  const answer = page.waitForResponse((r) => r.url().endsWith("/api/auth/signin") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Sign in" }).click();
  const res = await answer;
  if (ok) await page.waitForURL((u) => u.pathname !== "/signin");
  return { status: res.status(), json: await res.json() };
}

// Each waits as it did under vitest: a count of 0 includes hidden elements, and text is matched across every match.
const visible = (l: Locator) => l.waitFor({ state: "visible" });
const gone = (l: Locator, msg?: string) => expect.poll(() => l.count(), { message: msg, timeout: 10000 }).toBe(0);
const hasText = (l: Locator, text: string) => expect.poll(async () => (await l.allTextContents()).join(" "), { timeout: 10000 }).toContain(text);
// Both the side drawer (aside) and the phone tab bar (nav) are labelled Main. Counting all of them avoids picking one by position.
const nav = (page: Page) => page.getByLabel("Main", { exact: true });

async function expectWall(page: Page, url: string) {
  await page.goto(url);
  await visible(page.getByRole("heading", { name: WALL }));
  await gone(nav(page), url);
}

async function expectApp(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole("complementary", { name: "Main", exact: true, includeHidden: true }).waitFor({ state: "attached" });
  await gone(page.getByRole("heading", { name: WALL }), url);
}

async function setOwn(page: Page, emailed: string, next: string) {
  await page.getByLabel("Emailed password").fill(emailed);
  await page.getByLabel("New password", { exact: true }).fill(next);
  await page.getByLabel("Confirm new password").fill(next);
  await page.getByRole("button", { name: "Save and continue" }).click();
}

test.describe("qa:TC missing APL-2624 a Super-Admin-issued password must be changed at first sign-in", { tag: "@staging-capable" }, () => {
  // The browser is Playwright's own (playwright.config.ts: PW_CHROMIUM or the installed Chromium).
  test.beforeAll(async ({ browser: b }) => {
    test.setTimeout(180000);
    requirePasswordFixture();
    browser = b;
    admin = await superAdmin();
  });

  test.afterAll(async () => {
    for (const id of created) {
      const result = await admin.c.post(`/api/team/${id}/deactivate`, { reassign: "leaders" });
      expect(result.status, "Owned fixture deactivation must succeed").toBe(200);
    }
    if (admin) expect((await admin.c.post("/api/auth/signout")).status).toBe(204);
  });

  test("qa:TC missing AC1: after signing in on an emailed password every screen but Set your own password and Sign out is blocked", async () => {
    const { email, password } = await issued();
    const page = await openPage();
    await signIn(page, email, password);
    for (const url of SCREENS) await expectWall(page, url);
    await page.getByRole("button", { name: "Sign out" }).click();
    await visible(page.getByRole("heading", { name: "Sign in" }));
    await page.context().close();
  });

  test("qa:TC missing AC2: a valid new password opens the asked-for page and the emailed password stops working", async () => {
    const { email, password } = await issued();
    const page = await openPage();
    await signIn(page, email, password);
    await expectWall(page, "/projects");
    await setOwn(page, password, NEW_PW);
    await visible(page.getByRole("heading", { name: "Projects" }));
    await gone(page.getByRole("heading", { name: WALL }));
    await page.context().close();

    const old = await openPage();
    await signIn(old, email, password, false);
    await hasText(old.getByRole("alert"), WRONG);
    await old.context().close();

    const next = await openPage();
    await signIn(next, email, NEW_PW);
    await expectApp(next, "/");
    await next.context().close();
  });

  test("qa:TC missing AC3: a new password equal to the emailed one is refused with a clear message", async () => {
    const { email, password } = await issued();
    const page = await openPage();
    await signIn(page, email, password);
    await expectWall(page, "/");
    await setOwn(page, password, password);
    await hasText(page.getByRole("alert"), REFUSED);
    await visible(page.getByRole("heading", { name: WALL }));
    await page.context().close();
  });

  test("qa:TC missing AC4: in the forced state the server refuses app APIs, but not change-password, sign-out or me", async () => {
    const { email, password } = await issued();
    const page = await openPage();
    await signIn(page, email, password);
    await expectWall(page, "/");
    const seen = await page.evaluate(async () => {
      const blocked: { path: string; status: number; code: string | null }[] = [];
      for (const p of ["/api/projects", "/api/my-tasks", "/api/team", "/api/notifications"]) {
        const res = await fetch(p);
        blocked.push({ path: p, status: res.status, code: (await res.json()).code ?? null });
      }
      const me = await fetch("/api/auth/me");
      const meJson = await me.json();
      const pw = await fetch("/api/profile/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ current: "wrong-pass-1", password: "other-pass-2", confirm: "other-pass-2" }),
      });
      const pwJson = await pw.json();
      const out = await fetch("/api/auth/signout", { method: "POST" });
      return { blocked, me: me.status, must: meJson.user?.mustChangePassword, pw: pw.status, pwCode: pwJson.code ?? null, out: out.status };
    });
    for (const row of seen.blocked) {
      expect(row.status, row.path).toBe(403);
      expect(row.code, row.path).toBe("PASSWORD_CHANGE_REQUIRED");
    }
    expect(seen.me).toBe(200);
    expect(seen.must).toBe(true);
    expect(seen.pw).toBe(400); // reachable: refused for the wrong current password, not by the gate
    expect(seen.pwCode).not.toBe("PASSWORD_CHANGE_REQUIRED");
    expect(seen.out).toBe(204);
    await page.context().close();
  });

  test("qa:TC missing AC5: Resend sign-in details forces the change again, and the old emailed password stops working", async () => {
    const { email, password, id } = await issued();
    const page = await openPage();
    await signIn(page, email, password);
    await expectWall(page, "/projects");
    await setOwn(page, password, NEW_PW);
    await visible(page.getByRole("heading", { name: "Projects" }));
    expect((await admin.c.post(`/api/team/${id}/resend`)).status).toBe(200);
    const fresh = await emailedPassword(email, password);
    expect(fresh).not.toBe(password);
    await page.goto("/projects");
    await page.waitForURL(/\/signin/); // Resend signs every session out
    await signIn(page, email, fresh);
    await expectWall(page, "/team");
    await page.context().close();

    const old = await openPage();
    await signIn(old, email, NEW_PW, false);
    await hasText(old.getByRole("alert"), WRONG);
    await old.context().close();
  });

  test("qa:TC missing AC6: a person who signed up with their own password is never forced", async () => {
    const own = await ownPassword();
    const page = await openPage();
    await signIn(page, own.email, PW);
    for (const url of ["/", "/projects", "/profile"]) await expectApp(page, url);
    await page.context().close();
  });

  test("qa:TC missing AC6: a person who reset their password with Forgot password is never forced", async () => {
    const { email, password } = await issued();
    expect((await new Client().post("/api/auth/forgot-password", { email })).status).toBe(200);
    const token = await resetToken(email);
    expect(token).toBeTruthy();
    const page = await openPage();
    await page.goto(`/reset?token=${token}`);
    await page.getByLabel("New password", { exact: true }).fill("reset-pass-7");
    await page.getByLabel("Confirm new password").fill("reset-pass-7");
    await page.getByRole("button", { name: "Save and sign in" }).click();
    await visible(page.getByText("Password changed. Sign in with your new password."));
    await signIn(page, email, "reset-pass-7");
    await expectApp(page, "/");
    await page.context().close();

    const old = await openPage();
    await signIn(old, email, password, false);
    await hasText(old.getByRole("alert"), WRONG);
    await old.context().close();
  });

  test("qa:TC missing AC7: the Add person dialog and the sign-in email say the password is temporary, with no closable banner", async () => {
    const mail = signInDetailsMail("nakul17+zz-2624-e2e-copy@aplyd.com", "ZZ-TEST", "A Super Admin", "TempPass1234");
    expect(mail.text).toContain("This password is temporary.");
    expect(mail.text).not.toMatch(/stays valid/i);

    const page = await openPage();
    await signIn(page, admin.email, ADMIN_PW);
    await page.goto("/team");
    await page.getByRole("button", { name: /Add person/ }).click();
    const dlg = page.getByRole("dialog", { name: "Add person" });
    await hasText(dlg, REPLACE);
    expect(await dlg.textContent()).not.toMatch(/stays valid/i);
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await page.context().close();

    const { email, password } = await issued();
    const forced = await openPage();
    await signIn(forced, email, password);
    await expectWall(forced, "/");
    await gone(forced.getByRole("button", { name: "Close this message" }));
    expect(await forced.content()).not.toContain("still works until you do");
    await forced.context().close();
  });

  test("qa:TC missing AC8: the sign-in answer says mustChangePassword, true on an emailed password and false on their own", async () => {
    const { email, password } = await issued();
    const page = await openPage();
    const first = await signIn(page, email, password);
    expect(first.status).toBe(200);
    expect(first.json.user.mustChangePassword).toBe(true);
    await expectWall(page, "/");
    await setOwn(page, password, NEW_PW);
    await gone(page.getByRole("heading", { name: WALL }));
    await page.context().close();

    const next = await openPage();
    const again = await signIn(next, email, NEW_PW);
    expect(again.status).toBe(200);
    expect(again.json.user.mustChangePassword).toBe(false);
    await next.context().close();
  });
});
