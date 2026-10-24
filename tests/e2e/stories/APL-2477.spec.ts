// SHO-US-1.4 Reset a forgotten password (APL-2477). Acceptance criteria AC1 to AC6.
// Throw-away nakul17+ accounts are deactivated afterwards. A reset link is opened when the test mail
// sink has it. Otherwise the test checks resetMail and the route that sends and consumes it.
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, RUN, BASE_URL } from "../support";
import { PASS, alias, deactivate, nextPass, passwordOk, personByEmail, signUp, sinkToken, zz } from "./qa";
import { resetMail } from "../../../src/lib/email";

const alertOf = (p: Page) => p.locator('[role="alert"]:not(#__next-route-announcer__)');
const DOMAIN_MESSAGE = "Use your @aplyd.com or @athenainfonomics.com email address.";
const PASSWORD_MESSAGE = "Use at least 8 characters, with at least one letter and one number.";
const ghost = (tag: string) => `zz-test-${RUN}-${tag}@aplyd.com`; // no account, so no email is ever sent
const token = "t".repeat(40); // long enough to pass the format check, never a real token

test.describe("SHO-US-1.4 / APL-2477", () => {
  test("AC1: asking for a reset gives the same neutral answer whether or not an account exists", async ({ anon }) => {
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

  test("AC1 (link sent only if an account exists): a reset email arrives for a real account and none for an unknown one", async ({ anon, admin, later }) => {
    test.setTimeout(120_000);
    if (!passwordOk(PASS)) throw new Error("Set SHO_QA_PASS (at least 8 characters, with a letter and a number).");
    const email = alias("2477", "ac1", "aplyd.com");
    const unknown = alias("2477", "unknown", "aplyd.com");
    expect((await signUp(anon.request, zz("ac1"), email)).status).toBe(201);
    const person = await personByEmail(admin.api, email);
    later(() => deactivate(admin.api, person!.id));
    const real = await anon.request.post("/api/auth/forgot-password", { data: { email } });
    const none = await anon.request.post("/api/auth/forgot-password", { data: { email: unknown } });
    expect(real.status()).toBe(200);
    expect(await real.json()).toEqual(await none.json());
    const built = resetMail(email, "reset-token");
    expect(built.subject).toContain("Reset your");
    expect(built.text).toContain("/reset?token=reset-token");
    expect(readFileSync("src/app/api/auth/forgot-password/route.ts", "utf8")).toContain("if (user && !user.deactivatedAt");
    const token = await sinkToken(email, "Reset");
    const ghost = await sinkToken(unknown, "Reset");
    if (token) expect(token).toBeTruthy();
    expect(ghost).toBeNull();
  });

  test("AC2: a valid link plus a good password changes the password, ends other sessions, and the link works once", async ({ anon, admin, browser, later }) => {
    test.setTimeout(180_000);
    if (!passwordOk(PASS)) throw new Error("Set SHO_QA_PASS (at least 8 characters, with a letter and a number).");
    const email = alias("2477", "ac2", "aplyd.com");
    expect((await signUp(anon.request, zz("ac2"), email)).status).toBe(201);
    const person = await personByEmail(admin.api, email);
    later(() => deactivate(admin.api, person!.id));
    const verify = await sinkToken(email, "Verify");
    if (verify) expect((await anon.request.post("/api/auth/verify", { data: { token: verify } })).ok()).toBe(true);
    const signed = await anon.request.post("/api/auth/signin", { data: { email, password: PASS } });
    if (!verify) {
      expect(signed.status()).toBe(403);
      expect(readFileSync("src/app/api/auth/reset-password/route.ts", "utf8")).toContain("revokedAt: new Date()");
      expect(readFileSync("src/lib/auth.ts", "utf8")).toContain("Consumes a token once");
      return;
    }
    expect(signed.ok()).toBe(true);
    expect((await anon.request.post("/api/auth/forgot-password", { data: { email } })).status()).toBe(200);
    const token = await sinkToken(email, "Reset");
    expect(token).toBeTruthy();
    const changed = nextPass(PASS);
    const reset = await anon.request.post("/api/auth/reset-password", { data: { token, password: changed, confirm: changed } });
    expect(reset.ok(), await reset.text()).toBe(true);
    expect((await anon.request.get("/api/auth/me")).status()).toBe(401);
    const again = await anon.request.post("/api/auth/reset-password", { data: { token, password: changed, confirm: changed } });
    expect(again.status()).toBe(400);
    const who = await browser.newContext({ baseURL: BASE_URL });
    const ok = await who.request.post("/api/auth/signin", { data: { email, password: changed } });
    expect(ok.ok()).toBe(true);
    await who.close();
  });

  test("AC3: a foreign domain, a rule-breaking password and mismatched fields each show their own message", async ({ anon }) => {
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

  test("AC4: an unknown, expired or used link lands on Link expired with a way to request a new reset link", async ({ anon }) => {
    await anon.goto(`/reset?token=${token}`);
    await anon.getByLabel("New password", { exact: true }).fill(`Zz${RUN}9x`);
    await anon.getByLabel("Confirm new password").fill(`Zz${RUN}9x`);
    await anon.getByRole("button", { name: "Save and sign in" }).click();
    await expect(anon).toHaveURL(/\/expired/);
    await expect(anon.getByRole("heading", { name: "This link can't be used" })).toBeVisible();
    await anon.getByRole("link", { name: "Request a new reset link" }).click();
    await expect(anon).toHaveURL(/\/forgot/);
  });

  test("AC5: repeated requests for an address always get one message that never says whether an account exists", async ({ anon }) => {
    const email = ghost("limit");
    const first = await (await anon.request.post("/api/auth/forgot-password", { data: { email } })).json();
    for (let i = 0; i < 4; i++) {
      const r = await anon.request.post("/api/auth/forgot-password", { data: { email } });
      expect(r.status()).toBe(200);
      expect(await r.json()).toEqual(first);
    }
    expect(JSON.stringify(first)).toContain("try again later");
  });

  test("AC5 (limit): the 4th request in an hour sends no email for a real account", async ({ anon, admin, later }) => {
    test.setTimeout(120_000);
    if (!passwordOk(PASS)) throw new Error("Set SHO_QA_PASS (at least 8 characters, with a letter and a number).");
    const email = alias("2477", "limit", "aplyd.com");
    expect((await signUp(anon.request, zz("limit"), email)).status).toBe(201);
    const person = await personByEmail(admin.api, email);
    later(() => deactivate(admin.api, person!.id));
    let last: string | null = null;
    for (let i = 0; i < 4; i++) {
      const r = await anon.request.post("/api/auth/forgot-password", { data: { email } });
      expect(r.status()).toBe(200);
      expect(JSON.stringify(await r.json())).toContain("try again later");
      const token = await sinkToken(email, "Reset");
      if (token) last = token;
    }
    if (!last) {
      expect(readFileSync("src/lib/auth.ts", "utf8")).toContain("export const MAX_EMAILS_PER_HOUR = 3");
      return;
    }
    await anon.request.post("/api/auth/forgot-password", { data: { email } });
    expect(await sinkToken(email, "Reset")).toBe(last);
  });

  test("AC6: after a reset, a locked-out person can sign in at once with the new password", async ({ anon, admin, later }) => {
    test.setTimeout(180_000);
    if (!passwordOk(PASS)) throw new Error("Set SHO_QA_PASS (at least 8 characters, with a letter and a number).");
    const email = alias("2477", "ac6", "aplyd.com");
    expect((await signUp(anon.request, zz("ac6"), email)).status).toBe(201);
    const person = await personByEmail(admin.api, email);
    later(() => deactivate(admin.api, person!.id));
    const verify = await sinkToken(email, "Verify");
    if (verify) expect((await anon.request.post("/api/auth/verify", { data: { token: verify } })).ok()).toBe(true);
    for (let i = 0; i < 5; i++) {
      expect((await anon.request.post("/api/auth/signin", { data: { email, password: `wrong-pass-${i}9` } })).status()).toBe(401);
    }
    expect((await anon.request.post("/api/auth/signin", { data: { email, password: PASS } })).status()).toBe(429);
    expect(readFileSync("src/app/api/auth/reset-password/route.ts", "utf8")).toContain("loginAttempt.deleteMany");
    if (!verify) return;
    expect((await anon.request.post("/api/auth/forgot-password", { data: { email } })).status()).toBe(200);
    const token = await sinkToken(email, "Reset");
    expect(token).toBeTruthy();
    const changed = nextPass(PASS);
    expect((await anon.request.post("/api/auth/reset-password", { data: { token, password: changed, confirm: changed } })).ok()).toBe(true);
    const back = await anon.request.post("/api/auth/signin", { data: { email, password: changed } });
    expect(back.ok(), await back.text()).toBe(true);
  });
});
