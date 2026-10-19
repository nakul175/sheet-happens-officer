// SHO-US-1.4 Reset a forgotten password (APL-2477). Acceptance criteria AC1 to AC6.
// Reset links are read from the test mail sink. Accounts use nakul17+ aliases and are deactivated afterwards.
import type { Page } from "@playwright/test";
import { test, expect, RUN, login } from "../support";
import { PASS, passwordOk, alias, zz, nextPass, signUp, personByEmail, deactivate, waitForSinkMail, matchingMails, signInAs } from "./qa";

const alertOf = (p: Page) => p.locator('[role="alert"]:not(#__next-route-announcer__)');
const DOMAIN_MESSAGE = "Use your @aplyd.com or @athenainfonomics.com email address.";
const PASSWORD_MESSAGE = "Use at least 8 characters, with at least one letter and one number.";
const ghost = (tag: string) => `zz-test-${RUN}-${tag}@aplyd.com`; // no account, so no email is ever sent
const token = "t".repeat(40); // long enough to pass the format check, never a real token

function needPass() {
  test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  test.skip(!passwordOk(PASS), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
}

async function verified(anon: { request: import("@playwright/test").APIRequestContext }, admin: { api: import("../support").Api }, later: (fn: () => Promise<unknown>) => void, tag: string) {
  const email = alias("2477", tag, "aplyd.com");
  expect((await signUp(anon.request, zz(tag), email)).status).toBe(201);
  const verify = (await waitForSinkMail(email, "Verify")).token;
  expect((await anon.request.post("/api/auth/verify", { data: { token: verify } })).ok()).toBe(true);
  const person = await personByEmail(admin.api, email);
  later(() => deactivate(admin.api, person!.id));
  return email;
}

test.describe("SHO-US-1.4 / APL-2477 qa:TC missing", () => {
  test.beforeAll(() => {
    test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
    test.skip(!passwordOk(PASS), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
    try { login("ADMIN"); } catch { test.skip(true, "Set SHO_ADMIN_EMAIL and SHO_ADMIN_PASS (a Super Admin)."); }
  });

  // qa:TC missing
  test("AC1: asking for a reset gives the same neutral answer whether or not an account exists qa:TC missing", { annotation: { type: "qa:TC", description: "missing" } }, async ({ anon }) => {
    const a = await anon.request.post("/api/auth/forgot-password", { data: { email: ghost("a") } });
    const b = await anon.request.post("/api/auth/forgot-password", { data: { email: ghost("b") } });
    expect(a.status()).toBe(200);
    expect(await a.json()).toEqual(await b.json());
    expect(JSON.stringify(await a.json())).toMatch(/If an account exists/);
    // On the page it moves on to Check your email.
    await anon.goto("/forgot");
    await anon.getByLabel("Work email").fill(ghost("c"));
    await anon.getByRole("button", { name: "Send reset link" }).click();
    await expect(anon).toHaveURL(/\/check-reset/);
  });

  // qa:TC missing
  test("AC1 (link sent only if an account exists): a reset email arrives for a real account and none for an unknown one qa:TC missing", { annotation: { type: "qa:TC", description: "missing" } }, async ({ anon, admin, later }) => {
    needPass();
    const email = await verified(anon, admin, later, "ac1");
    const unknown = ghost("ac1-none");
    const none = await anon.request.post("/api/auth/forgot-password", { data: { email: unknown } });
    const real = await anon.request.post("/api/auth/forgot-password", { data: { email } });
    expect(none.status()).toBe(200);
    expect(real.status()).toBe(200);
    expect(await none.json()).toEqual(await real.json());
    const mail = await waitForSinkMail(email, "Reset");
    expect(mail.to?.toLowerCase()).toBe(email.toLowerCase());
    expect(mail.text).toContain("/reset?token=");
    expect((await matchingMails(unknown, "Reset")).length, "no reset email for an unknown address").toBe(0);
  });

  // qa:TC missing
  test("AC2: a valid link plus a good password changes the password, ends other sessions, and the link works once qa:TC missing", { annotation: { type: "qa:TC", description: "missing" } }, async ({ anon, admin, browser, later }) => {
    needPass();
    const email = await verified(anon, admin, later, "ac2");
    const here = await signInAs(browser, email, PASS);
    const other = await signInAs(browser, email, PASS);
    later(() => here.ctx.close());
    later(() => other.ctx.close());
    expect((await here.api.get("/api/auth/me")).status).toBe(200);
    expect((await other.api.get("/api/auth/me")).status).toBe(200);

    expect((await anon.request.post("/api/auth/forgot-password", { data: { email } })).ok()).toBe(true);
    const link = await waitForSinkMail(email, "Reset");
    const updated = nextPass(PASS);
    await anon.goto(`/reset?token=${link.token}`);
    await anon.getByLabel("New password", { exact: true }).fill(updated);
    await anon.getByLabel("Confirm new password").fill(updated);
    await anon.getByRole("button", { name: "Save and sign in" }).click();
    await expect(anon).toHaveURL(/\/signin\?reset=1/);

    expect((await here.api.get("/api/auth/me")).status).toBe(401);
    expect((await other.api.get("/api/auth/me")).status).toBe(401);
    expect((await anon.request.post("/api/auth/signin", { data: { email, password: PASS } })).status()).toBe(401);
    const neu = await anon.request.post("/api/auth/signin", { data: { email, password: updated } });
    expect((await neu.text()).includes(updated)).toBe(false);
    expect(neu.status()).toBe(200);

    const second = await anon.request.post("/api/auth/reset-password", { data: { token: link.token, password: updated, confirm: updated } });
    expect(second.status()).toBe(400);
    expect((await second.json()).error).toBe("This link has expired or was already used.");
  });

  // qa:TC missing
  test("AC3: a foreign domain, a rule-breaking password and mismatched fields each show their own message qa:TC missing", { annotation: { type: "qa:TC", description: "missing" } }, async ({ anon }) => {
    await anon.goto("/forgot");
    await anon.getByLabel("Work email").fill("someone@gmail.com");
    await anon.getByRole("button", { name: "Send reset link" }).click();
    await expect(alertOf(anon)).toContainText(DOMAIN_MESSAGE);

    await anon.goto(`/reset?token=${token}`);
    await anon.getByLabel("New password", { exact: true }).fill("short1");
    await anon.getByLabel("Confirm new password").fill("short1");
    await anon.getByRole("button", { name: "Save and sign in" }).click();
    await expect(alertOf(anon)).toContainText(PASSWORD_MESSAGE);

    await anon.getByLabel("New password", { exact: true }).fill(`Zz${RUN}9x`);
    await anon.getByLabel("Confirm new password").fill(`Zz${RUN}9y`);
    await anon.getByRole("button", { name: "Save and sign in" }).click();
    await expect(alertOf(anon)).toContainText("Passwords do not match.");
  });

  // qa:TC missing
  test("AC4: an unknown, expired or used link lands on Link expired with a way to request a new reset link qa:TC missing", { annotation: { type: "qa:TC", description: "missing" } }, async ({ anon }) => {
    await anon.goto(`/reset?token=${token}`);
    await anon.getByLabel("New password", { exact: true }).fill(`Zz${RUN}9x`);
    await anon.getByLabel("Confirm new password").fill(`Zz${RUN}9x`);
    await anon.getByRole("button", { name: "Save and sign in" }).click();
    await expect(anon).toHaveURL(/\/expired/);
    await expect(anon.getByRole("heading", { name: "This link has expired" })).toBeVisible();
    await anon.getByRole("link", { name: "Request a new reset link" }).click();
    await expect(anon).toHaveURL(/\/forgot/);
  });

  // qa:TC missing
  test("AC5: repeated requests for an address always get one message that never says whether an account exists qa:TC missing", { annotation: { type: "qa:TC", description: "missing" } }, async ({ anon }) => {
    const email = ghost("limit");
    const first = await (await anon.request.post("/api/auth/forgot-password", { data: { email } })).json();
    for (let i = 0; i < 4; i++) {
      const r = await anon.request.post("/api/auth/forgot-password", { data: { email } });
      expect(r.status()).toBe(200);
      expect(await r.json()).toEqual(first);
    }
    expect(JSON.stringify(first)).toContain("try again later");
  });

  // qa:TC missing
  test("AC5 (limit): the 4th request in an hour sends no email for a real account qa:TC missing", { annotation: { type: "qa:TC", description: "missing" } }, async ({ anon, admin, later }) => {
    needPass();
    const email = await verified(anon, admin, later, "ac5");
    let previous = "";
    for (let i = 0; i < 3; i++) {
      expect((await anon.request.post("/api/auth/forgot-password", { data: { email } })).ok()).toBe(true);
      previous = (await waitForSinkMail(email, "Reset", previous || null)).token;
    }
    const before = (await matchingMails(email, "Reset")).length;
    const first = await (await anon.request.post("/api/auth/forgot-password", { data: { email: ghost("ac5-same") } })).json();
    const limited = await anon.request.post("/api/auth/forgot-password", { data: { email } });
    expect(limited.status()).toBe(200);
    expect(await limited.json()).toEqual(first);
    expect(JSON.stringify(await limited.json())).toContain("try again later");
    expect((await matchingMails(email, "Reset")).length, "no fourth reset email").toBe(before);
  });

  // qa:TC missing
  test("AC6: after a reset, a locked-out person can sign in at once with the new password qa:TC missing", { annotation: { type: "qa:TC", description: "missing" } }, async ({ anon, admin, later }) => {
    needPass();
    const email = await verified(anon, admin, later, "ac6");
    for (let i = 0; i < 5; i++) {
      expect((await anon.request.post("/api/auth/signin", { data: { email, password: `wrong-pass-${i}9` } })).status()).toBe(401);
    }
    expect((await anon.request.post("/api/auth/signin", { data: { email, password: PASS } })).status()).toBe(429);

    expect((await anon.request.post("/api/auth/forgot-password", { data: { email } })).ok()).toBe(true);
    const link = await waitForSinkMail(email, "Reset");
    const updated = nextPass(PASS);
    const reset = await anon.request.post("/api/auth/reset-password", { data: { token: link.token, password: updated, confirm: updated } });
    expect(reset.ok(), await reset.text()).toBe(true);

    const neu = await anon.request.post("/api/auth/signin", { data: { email, password: updated } });
    expect(neu.status(), "the lockout is cleared by the reset").toBe(200);
    expect((await neu.text()).includes(updated)).toBe(false);
  });
});
