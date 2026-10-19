// APL-2715 Playwright checks. No TC id is written on the issue, so each title carries qa:TC missing.
// Local only, workers=1 (vitest.e2e.config.mts). Thrown-away people use ZZ-TEST names and nakul17+ aliases.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { signInDetailsMail } from "@/lib/email";
import { BASE, Client, OUTBOX, PW, superAdmin, type Account } from "../tests/helpers";

const WALL = "Set your own password";
const REPLACE = "The person must replace it with their own when they first sign in.";
const REFUSED = "Choose a new password. It cannot be the one we emailed you.";
const SCREENS = ["/", "/projects", "/team", "/profile", "/search"];
const run = Date.now().toString(36);
let seq = 0;
let browser: Browser;
let admin: Account;
const created: string[] = [];

function signInMail(email: string) {
  const files = readdirSync(OUTBOX).sort();
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8"))).filter((m) => m.to === email && /Your Sheet Happens Officer account/.test(m.subject));
  const text = (mails.at(-1)?.text ?? "") as string;
  return { count: mails.length, text, password: text.match(/Password: (\S+)/)?.[1] ?? "" };
}

function resetToken(email: string) {
  const files = readdirSync(OUTBOX).sort();
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8"))).filter((m) => m.to === email && /Reset your Sheet Happens Officer password/.test(m.subject));
  return (mails.at(-1)?.text as string | undefined)?.match(/token=([\w-]+)/)?.[1] ?? "";
}

async function issued() {
  const tag = `${run}${seq++}`;
  const email = `nakul17+apl2715-e2e-${tag}@aplyd.com`;
  const createdRes = await admin.c.post("/api/team", { firstName: "ZZ-TEST", lastName: `Wall${tag}`, email, role: "MEMBER" });
  expect(createdRes.status, JSON.stringify(createdRes.json)).toBe(201);
  created.push(createdRes.json.person.id as string);
  const password = signInMail(email).password;
  expect(password).toMatch(/^[A-Za-z0-9]{12}$/);
  return { email, password, id: createdRes.json.person.id as string };
}

async function openSession() {
  const ctx = await browser.newContext({ baseURL: BASE });
  const page = await ctx.newPage();
  return { ctx, page };
}

/** Waits for the sign-in to land, so a following goto does not abort the request that sets the cookie. */
async function signIn(page: Page, email: string, password: string, ok = true) {
  await page.goto("/signin");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (ok) await page.waitForURL((u) => u.pathname !== "/signin");
}

// The runner is vitest with playwright-core, so there are no web-first matchers. These wait the same way.
const visible = (l: Locator) => l.waitFor({ state: "visible" });
const gone = (l: Locator, msg?: string) => expect.poll(() => l.count(), { message: msg, timeout: 10000 }).toBe(0);
const hasText = (l: Locator, text: string) => expect.poll(async () => (await l.first().textContent()) ?? "", { timeout: 10000 }).toContain(text);

async function expectWall(page: Page, url: string) {
  await page.goto(url);
  await visible(page.getByRole("heading", { name: WALL }));
  await gone(page.locator('[aria-label="Main"]:visible'), url);
}

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) {
    throw new Error(`Refusing to run against ${BASE}: this spec is local only.`);
  }
  browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || "/usr/local/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  admin = await superAdmin();
}, 180000);

afterAll(async () => {
  await browser?.close();
  for (const id of created) {
    await admin?.c.post(`/api/team/${id}/deactivate`, { reassign: "leaders" });
  }
});

it("after signing in with a Super-Admin-issued password every screen but set-your-own-password and sign-out is blocked qa:TC missing", async () => {
  const { email, password } = await issued();
  const { ctx, page } = await openSession();
  await signIn(page, email, password);
  for (const url of SCREENS) await expectWall(page, url);
  await page.getByRole("button", { name: "Sign out" }).click();
  await visible(page.getByRole("heading", { name: "Sign in" }));
  await ctx.close();
});

it("a valid new password opens the asked-for page and the emailed password stops working qa:TC missing", async () => {
  const { email, password } = await issued();
  const { ctx, page } = await openSession();
  await signIn(page, email, password);
  await expectWall(page, "/projects");
  await page.getByLabel("Emailed password").fill(password);
  await page.getByLabel("New password", { exact: true }).fill("my-own-pass-7");
  await page.getByLabel("Confirm new password").fill("my-own-pass-7");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await visible(page.getByRole("heading", { name: "Projects" }));
  await gone(page.getByRole("heading", { name: WALL }));
  await visible(page.locator('[aria-label="Main"]:visible').first());
  await ctx.close();

  const old = await openSession();
  await signIn(old.page, email, password, false);
  await hasText(old.page.getByRole("alert"), "Email or password is incorrect.");
  await old.ctx.close();

  const next = await openSession();
  await signIn(next.page, email, "my-own-pass-7");
  await visible(next.page.getByRole("heading", { name: "My tasks" }));
  await gone(next.page.getByRole("heading", { name: WALL }));
  await next.ctx.close();
});

it("a new password equal to the emailed one is refused with a clear message qa:TC missing", async () => {
  const { email, password } = await issued();
  const { ctx, page } = await openSession();
  await signIn(page, email, password);
  await expectWall(page, "/");
  await page.getByLabel("Emailed password").fill(password);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await hasText(page.getByRole("alert"), REFUSED);
  await visible(page.getByRole("heading", { name: WALL }));
  await ctx.close();
});

it("in the forced state app APIs other than change-password, sign-out and me answer 403 qa:TC missing", async () => {
  const { email, password } = await issued();
  const { ctx, page } = await openSession();
  await signIn(page, email, password);
  await expectWall(page, "/");
  const blocked = await page.evaluate(async () => {
    const paths = ["/api/projects", "/api/my-tasks", "/api/team", "/api/notifications"];
    const out: { path: string; status: number; code: string | null }[] = [];
    for (const path of paths) {
      const res = await fetch(path);
      const json = await res.json();
      out.push({ path, status: res.status, code: json.code ?? null });
    }
    return out;
  });
  for (const row of blocked) {
    expect(row.status, row.path).toBe(403);
    expect(row.code, row.path).toBe("PASSWORD_CHANGE_REQUIRED");
  }
  const allowed = await page.evaluate(async () => {
    const me = await fetch("/api/auth/me");
    const meJson = await me.json();
    const password = await fetch("/api/profile/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current: "wrong-pass-1", password: "other-pass-2", confirm: "other-pass-2" }),
    });
    const passwordJson = await password.json();
    const out = await fetch("/api/auth/signout", { method: "POST" });
    return {
      meStatus: me.status,
      mustChangePassword: meJson.user?.mustChangePassword,
      passwordStatus: password.status,
      passwordCode: passwordJson.code ?? null,
      signOutStatus: out.status,
    };
  });
  expect(allowed.meStatus).toBe(200);
  expect(allowed.mustChangePassword).toBe(true);
  expect(allowed.passwordStatus).toBe(400);
  expect(allowed.passwordCode).not.toBe("PASSWORD_CHANGE_REQUIRED");
  expect(allowed.signOutStatus).toBe(204);
  await ctx.close();
});

it("resend sign-in details puts the person back behind the password wall qa:TC missing", async () => {
  const { email, password, id } = await issued();
  const { ctx, page } = await openSession();
  await signIn(page, email, password);
  await expectWall(page, "/projects");
  const resent = await admin.c.post(`/api/team/${id}/resend`);
  expect(resent.status).toBe(200);
  const next = signInMail(email);
  expect(next.password).not.toBe(password);
  await page.goto("/projects");
  await page.waitForURL(/\/signin/);
  await signIn(page, email, next.password);
  await expectWall(page, "/team");
  await ctx.close();
  const old = await openSession();
  await signIn(old.page, email, password, false);
  await hasText(old.page.getByRole("alert"), "Email or password is incorrect.");
  await old.ctx.close();
});

it("a person who set their own password is never shown the password wall qa:TC missing", async () => {
  const { ctx, page } = await openSession();
  await signIn(page, admin.email, PW);
  for (const url of ["/", "/projects", "/profile"]) {
    await page.goto(url);
    await visible(page.locator('[aria-label="Main"]:visible').first());
    await gone(page.getByRole("heading", { name: WALL }), url);
  }
  const me = await page.evaluate(async () => {
    const res = await fetch("/api/auth/me");
    const json = await res.json();
    return { status: res.status, mustChangePassword: json.user?.mustChangePassword };
  });
  expect(me.status).toBe(200);
  expect(me.mustChangePassword).toBe(false);
  await ctx.close();
});

it("a person who reset their password by email is never shown the password wall qa:TC missing", async () => {
  const { email, password } = await issued();
  const asked = await new Client().post("/api/auth/forgot-password", { email });
  expect(asked.status).toBe(200);
  const token = resetToken(email);
  expect(token).toBeTruthy();
  const { ctx, page } = await openSession();
  await page.goto(`/reset?token=${token}`);
  await page.getByLabel("New password", { exact: true }).fill("reset-pass-7");
  await page.getByLabel("Confirm new password").fill("reset-pass-7");
  await page.getByRole("button", { name: "Save and sign in" }).click();
  await visible(page.getByText("Password changed. Sign in with your new password."));
  await signIn(page, email, "reset-pass-7");
  await visible(page.getByRole("heading", { name: "My tasks" }));
  await gone(page.getByRole("heading", { name: WALL }));
  await ctx.close();
  const old = await openSession();
  await signIn(old.page, email, password, false);
  await hasText(old.page.getByRole("alert"), "Email or password is incorrect.");
  await old.ctx.close();
});

it("the add-person dialog and the sign-in email say the password is temporary qa:TC missing", async () => {
  const mail = signInDetailsMail("nakul17+apl2715-copy@aplyd.com", "ZZ-TEST", "A Super Admin", "TempPass1234");
  expect(mail.text.toLowerCase()).toContain("temporary");
  expect(mail.text).not.toContain("stays valid");
  const shell = readFileSync("src/app/(app)/Shell.tsx", "utf8");
  expect(shell).not.toContain("The emailed one still works until you do.");
  const { ctx, page } = await openSession();
  await signIn(page, admin.email, PW);
  await page.goto("/team");
  await page.getByRole("button", { name: /Add person/ }).click();
  const dlg = page.getByRole("dialog", { name: "Add person" });
  await hasText(dlg, REPLACE);
  expect(await dlg.textContent()).not.toMatch(/stays valid/i);
  await dlg.getByRole("button", { name: "Cancel" }).click();
  await ctx.close();
});
