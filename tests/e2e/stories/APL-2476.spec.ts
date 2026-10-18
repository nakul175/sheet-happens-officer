// SHO-US-1.3 Sign in with email and password (APL-2476). Acceptance criteria AC1 to AC5.
import type { Page } from "@playwright/test";
import { test, expect, RUN, login } from "../support";
import { PASS, passwordOk, alias, zz, signUp, personByEmail, deactivate, waitForSinkMail } from "./qa";

const alertOf = (p: Page) => p.locator('[role="alert"]:not(#__next-route-announcer__)');
const WRONG = "Email or password is incorrect.";

function needPass() {
  test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  test.skip(!passwordOk(PASS), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
}

test.describe("SHO-US-1.3 / APL-2476", () => {
  test("AC1: the right password lands on My tasks with a 30-day session cookie that page scripts cannot read", async ({ anon }) => {
    await anon.goto("/signin");
    await anon.getByLabel("Work email").fill(login("ADMIN").email);
    await anon.getByLabel("Password").fill(login("ADMIN").password);
    await anon.getByRole("button", { name: "Sign in" }).click();
    await expect(anon).toHaveURL(/\/$/);
    await expect(anon.getByRole("heading", { name: /my tasks/i }).first()).toBeVisible();
    const cookie = (await anon.context().cookies()).find((c) => c.name === "sho_session");
    expect(cookie, "session cookie").toBeTruthy();
    expect(cookie!.httpOnly).toBe(true);
    const days = (cookie!.expires - Date.now() / 1000) / 86400;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30.1);
    expect(await anon.evaluate(() => document.cookie)).not.toContain("sho_session");
  });

  test("AC2: a wrong password and an unknown email get the same message, on the page and in the API", async ({ anon }) => {
    await anon.goto("/signin");
    await anon.getByLabel("Work email").fill(`zz-test-${RUN}-ghost@aplyd.com`);
    await anon.getByLabel("Password").fill("not-the-password-1");
    await anon.getByRole("button", { name: "Sign in" }).click();
    await expect(alertOf(anon)).toContainText(WRONG);

    // One wrong try on the real account (well under the lockout of 5); the next good sign-in clears it.
    const real = await anon.request.post("/api/auth/signin", { data: { email: login("ADMIN").email, password: "not-the-password-1" } });
    const none = await anon.request.post("/api/auth/signin", { data: { email: `zz-test-${RUN}-ghost2@aplyd.com`, password: "not-the-password-1" } });
    expect(real.status()).toBe(401);
    expect(none.status()).toBe(401);
    expect(await real.json()).toEqual(await none.json());
    expect((await none.json()).error).toBe(WRONG);
    const ok = await anon.request.post("/api/auth/signin", { data: { email: login("ADMIN").email, password: login("ADMIN").password } });
    expect(ok.status()).toBe(200);
  });

  test("AC3: an unverified account with the right password sees Verify your email first with a Resend link", async ({ anon, admin, later }) => {
    needPass();
    const email = alias("2476", "ac3", "aplyd.com");
    expect((await signUp(anon.request, zz("ac3"), email)).status).toBe(201);
    await waitForSinkMail(email, "Verify");
    const person = await personByEmail(admin.api, email);
    expect(person?.status).toBe("UNVERIFIED");
    later(() => deactivate(admin.api, person!.id));

    const wrong = await anon.request.post("/api/auth/signin", { data: { email, password: `not-${PASS}` } });
    expect(wrong.status()).toBe(401);
    expect((await wrong.json()).error).toBe(WRONG);

    await anon.goto("/signin");
    await anon.getByLabel("Work email").fill(email);
    await anon.getByLabel("Password").fill(PASS);
    await anon.getByRole("button", { name: "Sign in" }).click();
    const alert = alertOf(anon);
    await expect(alert).toContainText("Verify your email first.");
    await expect(alert.getByRole("button", { name: "Resend link" })).toBeVisible();
    expect((await anon.request.get("/api/auth/me")).status()).toBe(401);

    await alert.getByRole("button", { name: "Resend link" }).click();
    await expect(anon).toHaveURL(/\/check-email/);
    const resent = await waitForSinkMail(email, "Verify");
    expect(resent.to?.toLowerCase()).toBe(email.toLowerCase());
  });

  test("AC4: five failed tries lock the email for 15 minutes, for an address with no account too, and the password is no longer checked", async ({ anon }) => {
    const email = `zz-test-${RUN}-lock@example.invalid`; // no account, so no real person is locked out
    for (let i = 0; i < 5; i++) {
      const r = await anon.request.post("/api/auth/signin", { data: { email, password: `wrong-pass-${i}9` } });
      expect(r.status(), `try ${i + 1}`).toBe(401);
    }
    const locked = await anon.request.post("/api/auth/signin", { data: { email, password: "wrong-pass-69" } });
    expect(locked.status()).toBe(429);
    expect((await locked.json()).error).toBe("Too many attempts. Try again in 15 minutes.");
    await anon.goto("/signin");
    await anon.getByLabel("Work email").fill(email);
    await anon.getByLabel("Password").fill("wrong-pass-79");
    await anon.getByRole("button", { name: "Sign in" }).click();
    await expect(alertOf(anon)).toContainText("Too many attempts. Try again in 15 minutes.");
  });

  test("AC5: a deactivated account with the right password is refused with This account is deactivated", async ({ anon, admin, later }) => {
    needPass();
    const email = alias("2476", "ac5", "aplyd.com");
    expect((await signUp(anon.request, zz("ac5"), email)).status).toBe(201);
    const token = (await waitForSinkMail(email, "Verify")).token;
    expect((await anon.request.post("/api/auth/verify", { data: { token } })).ok()).toBe(true);
    const person = await personByEmail(admin.api, email);
    later(() => deactivate(admin.api, person!.id));
    expect((await anon.request.post("/api/auth/signin", { data: { email, password: PASS } })).status()).toBe(200);
    await anon.request.post("/api/auth/signout");
    expect((await admin.api.post(`/api/team/${person!.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);

    const refused = await anon.request.post("/api/auth/signin", { data: { email, password: PASS } });
    expect(refused.status()).toBe(403);
    const body = await refused.json();
    expect(body.error).toBe("This account is deactivated.");
    expect(JSON.stringify(body)).not.toMatch(/orgRole|project/i);
    await anon.goto("/signin");
    await anon.getByLabel("Work email").fill(email);
    await anon.getByLabel("Password").fill(PASS);
    await anon.getByRole("button", { name: "Sign in" }).click();
    await expect(alertOf(anon)).toContainText("This account is deactivated.");
    expect((await anon.request.get("/api/auth/me")).status()).toBe(401);
  });
});
