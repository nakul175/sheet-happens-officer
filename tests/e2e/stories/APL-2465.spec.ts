// APL-2465 · [SHO-E1] Accounts and sign-in. One test per acceptance criterion.
// Pam qa:TC: none on the issue. Password comes from SHO_QA_PASS. Names use ZZ-TEST. Emails are nakul17+ aliases.
// athenainfonomics.com self-signup belongs to SHO-E23 and is not re-tested here.
import type { Page } from "@playwright/test";
import { test, login } from "../support";
import { PASS, passwordOk, alias, zz, gate, signUp, signInAs, mailToken, nextPass, personByEmail, deactivate, expect, BASE_URL, waitForSinkMail } from "./qa";

const DOMAIN = "Use your @aplyd.com or @athenainfonomics.com email address.";
const alertOf = (p: Page) => p.locator('[role="alert"]:not(#__next-route-announcer__)');

test.beforeAll(async ({ request }) => {
  if (!PASS) throw new Error("Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
  login("ADMIN");
  await gate(request);
});

test("AC1: an @aplyd.com sign-up creates an unverified account and sends a verification email; other domains are refused", async ({ anon, admin, later }) => {
  const email = alias("2465", "ac1", "aplyd.com");
  const signed = await signUp(anon.request, zz("ac1"), email);
  expect(signed.status, signed.body).toBe(201);
  expect(signed.json).toEqual({ status: "check_email" });
  const person = await personByEmail(admin.api, email);
  expect(person?.status).toBe("UNVERIFIED");
  later(() => deactivate(admin.api, person!.id));
  expect(mailToken(email, "Verify"), "verification email in the local outbox").toBeTruthy();

  for (const refused of [alias("2465", "ac1-gmail"), alias("2465", "ac1-look", "aplyd.co")]) {
    const r = await signUp(anon.request, zz("refused"), refused);
    expect(r.status, refused).toBe(400);
    expect(r.body, refused).toContain(DOMAIN);
  }
  await anon.goto("/signup");
  await anon.getByLabel("Full name").fill(zz("refused"));
  await anon.getByLabel("Work email").fill(alias("2465", "ac1-page"));
  await anon.getByLabel("Password").fill(PASS);
  await anon.getByRole("button", { name: "Create account" }).click();
  await expect(alertOf(anon)).toContainText(DOMAIN);
  expect((await personByEmail(admin.api, alias("2465", "ac1-page")))).toBeNull();
});

test("AC2: opening the verification link verifies the account and it can sign in", async ({ anon, admin, browser, later }) => {
  const email = alias("2465", "ac2", "aplyd.com");
  const signed = await signUp(anon.request, zz("ac2"), email);
  expect(signed.status, signed.body).toBe(201);
  const token = mailToken(email, "Verify");
  expect(token, "verification email").toBeTruthy();
  await anon.goto(`/verify?token=${token}`);
  await expect(anon.getByRole("heading", { name: "Email verified" })).toBeVisible();
  const person = await personByEmail(admin.api, email);
  expect(person?.status).toBe("ACTIVE");
  later(() => deactivate(admin.api, person!.id));
  const who = await signInAs(browser, email, PASS);
  later(() => who.ctx.close());
  expect(who.user.email).toBe(email);
  await who.page.goto("/");
  await expect(who.page.getByRole("heading", { name: "My tasks" })).toBeVisible();
});

test("AC3: the right password reaches Home; a wrong password shows an error and does not sign in", async ({ anon, admin, browser, later }) => {
  const email = alias("2465", "ac3", "aplyd.com");
  expect((await signUp(anon.request, zz("ac3"), email)).status).toBe(201);
  const token = mailToken(email, "Verify");
  expect(token).toBeTruthy();
  expect((await anon.request.post("/api/auth/verify", { data: { token } })).ok()).toBe(true);
  const person = await personByEmail(admin.api, email);
  later(() => deactivate(admin.api, person!.id));

  await anon.goto("/signin");
  await anon.getByLabel("Work email").fill(email);
  await anon.getByLabel("Password").fill(PASS);
  await anon.getByRole("button", { name: "Sign in" }).click();
  await expect(anon).toHaveURL(/\/$/);
  await expect(anon.getByRole("heading", { name: "My tasks" })).toBeVisible();

  const fresh = await browser.newContext({
    baseURL: BASE_URL,
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
  });
  const page = await fresh.newPage();
  later(() => fresh.close());
  await page.goto("/signin");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(nextPass(PASS));
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(alertOf(page)).toContainText("Email or password is incorrect.");
  const me = await fresh.request.get("/api/auth/me");
  const body = await me.text();
  const pass = PASS;
  expect(body.includes(pass)).toBe(false);
  expect(me.status()).toBe(401);
});

test("AC4: a reset link sets a new password and the old one stops working", async ({ anon, admin, later }) => {
  const email = alias("2465", "ac4", "aplyd.com");
  expect((await signUp(anon.request, zz("ac4"), email)).status).toBe(201);
  const verify = mailToken(email, "Verify");
  expect(verify).toBeTruthy();
  expect((await anon.request.post("/api/auth/verify", { data: { token: verify } })).ok()).toBe(true);
  const person = await personByEmail(admin.api, email);
  later(() => deactivate(admin.api, person!.id));

  await anon.goto("/forgot");
  await anon.getByLabel("Work email").fill(email);
  await anon.getByRole("button", { name: "Send reset link" }).click();
  await expect(anon).toHaveURL(/\/check-reset/);
  const token = mailToken(email, "Reset");
  expect(token, "reset email").toBeTruthy();
  const updated = nextPass(PASS);
  await anon.goto(`/reset?token=${token}`);
  await anon.getByLabel("New password", { exact: true }).fill(updated);
  await anon.getByLabel("Confirm new password").fill(updated);
  await anon.getByRole("button", { name: "Save and sign in" }).click();
  await expect(anon).toHaveURL(/\/signin\?reset=1/);

  const oldTry = await anon.request.post("/api/auth/signin", { data: { email, password: PASS } });
  expect(oldTry.status()).toBe(401);
  const neu = await anon.request.post("/api/auth/signin", { data: { email, password: updated } });
  const body = await neu.text();
  const pass = updated;
  expect(body.includes(pass)).toBe(false);
  expect(neu.status()).toBe(200);
});

test("AC5: sign-out ends the session, and the old email-only sign-in no longer grants access", async ({ anon, admin, browser, later }) => {
  const email = alias("2465", "ac5", "aplyd.com");
  expect((await signUp(anon.request, zz("ac5"), email)).status).toBe(201);
  const token = mailToken(email, "Verify");
  expect((await anon.request.post("/api/auth/verify", { data: { token } })).ok()).toBe(true);
  const person = await personByEmail(admin.api, email);
  later(() => deactivate(admin.api, person!.id));
  const who = await signInAs(browser, email, PASS);
  later(() => who.ctx.close());
  expect((await who.api.get("/api/auth/me")).status).toBe(200);
  await who.page.goto("/profile");
  await who.page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(who.page).toHaveURL(/\/signin/);
  expect((await who.api.get("/api/auth/me")).status).toBe(401);

  const legacy = await anon.request.post("/api/session", { data: { email } });
  expect(legacy.status(), "email-only sign-in is gone").toBe(404);
  expect((await anon.request.get("/api/auth/me")).status()).toBe(401);
});

test("AC6: editing the profile and ending other sessions both take effect", async ({ anon, admin, browser, later }) => {
  const email = alias("2465", "ac6", "aplyd.com");
  expect((await signUp(anon.request, zz("ac6"), email)).status).toBe(201);
  const token = mailToken(email, "Verify");
  expect((await anon.request.post("/api/auth/verify", { data: { token } })).ok()).toBe(true);
  const person = await personByEmail(admin.api, email);
  later(() => deactivate(admin.api, person!.id));
  const here = await signInAs(browser, email, PASS);
  const other = await signInAs(browser, email, PASS);
  later(() => here.ctx.close());
  later(() => other.ctx.close());

  const renamed = zz("renamed");
  await here.page.goto("/profile");
  await here.page.getByLabel("Name").fill(renamed);
  await here.page.getByRole("button", { name: "Save name" }).click();
  await expect(here.page.getByText("Saved. Your new name shows after the page reloads.")).toBeVisible();
  expect((await here.api.get("/api/auth/me")).json.user.name).toBe(renamed);

  await here.page.reload();
  await here.page.getByRole("button", { name: "Sign out of all other devices" }).click();
  await expect(here.page.getByText("Signed out of 1 other device.")).toBeVisible();
  expect((await other.api.get("/api/auth/me")).status).toBe(401);
  expect((await here.api.get("/api/auth/me")).status).toBe(200);
});

const PRODUCTION_HOSTS = new Set(["sheethappensofficer.com", "www.sheethappensofficer.com", "app.sheethappensofficer.com"]);

function mailLinkHost(text: string | null | undefined) {
  const raw = text?.match(/https?:\/\/[^\s"'<>]+/)?.[0] ?? "http://invalid";
  const url = new URL(raw);
  return { host: url.host.toLowerCase(), hostname: url.hostname.toLowerCase() };
}

test("AC7: staging auth mail is in the test mail sink within 60 seconds and each link completes", async ({ anon, admin, later }) => {
  test.setTimeout(240_000);
  const email = alias("2465", "ac7", "aplyd.com");
  expect(email.startsWith("nakul17+"), "the address is a nakul17+ alias").toBe(true);
  expect((await signUp(anon.request, zz("ac7"), email)).status).toBe(201);
  const first = await waitForSinkMail(email, "Verify");
  expect(first.to?.toLowerCase()).toBe(email.toLowerCase());

  expect((await anon.request.post("/api/auth/resend-verification", { data: { email } })).ok()).toBe(true);
  const second = await waitForSinkMail(email, "Verify", first.token);
  expect(second.token).not.toBe(first.token);
  for (const mail of [first, second]) {
    const link = mailLinkHost(mail.text);
    expect(PRODUCTION_HOSTS.has(link.hostname), "the link stays on staging").toBe(false);
    expect(link.host).toBe(new URL(BASE_URL).host);
  }
  await anon.goto(`/verify?token=${second.token}`);
  await expect(anon.getByRole("heading", { name: "Email verified" })).toBeVisible();
  const person = await personByEmail(admin.api, email);
  expect(person?.status).toBe("ACTIVE");
  later(() => deactivate(admin.api, person!.id));

  expect((await anon.request.post("/api/auth/forgot-password", { data: { email } })).ok()).toBe(true);
  const reset = await waitForSinkMail(email, "Reset");
  expect(reset.to?.toLowerCase()).toBe(email.toLowerCase());
  const resetLink = mailLinkHost(reset.text);
  expect(PRODUCTION_HOSTS.has(resetLink.hostname)).toBe(false);
  expect(resetLink.host).toBe(new URL(BASE_URL).host);
  const updated = nextPass(PASS);
  await anon.goto(`/reset?token=${reset.token}`);
  await anon.getByLabel("New password", { exact: true }).fill(updated);
  await anon.getByLabel("Confirm new password").fill(updated);
  await anon.getByRole("button", { name: "Save and sign in" }).click();
  await expect(anon).toHaveURL(/\/signin\?reset=1/);
  expect((await anon.request.post("/api/auth/signin", { data: { email, password: PASS } })).status()).toBe(401);
  const neu = await anon.request.post("/api/auth/signin", { data: { email, password: updated } });
  const body = await neu.text();
  expect(body.includes(updated)).toBe(false);
  expect(neu.status()).toBe(200);
});
