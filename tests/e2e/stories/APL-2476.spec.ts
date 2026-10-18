// SHO-US-1.3 Sign in with email and password (APL-2476). Acceptance criteria AC1 to AC5.
import type { Page } from "@playwright/test";
import { test, expect, RUN } from "../support";

const alertOf = (p: Page) => p.locator('[role="alert"]:not(#__next-route-announcer__)');
const WRONG = "Email or password is incorrect.";

test.describe("SHO-US-1.3 / APL-2476", () => {
  test("AC1: the right password lands on My tasks with a 30-day session cookie that page scripts cannot read", async ({ anon }) => {
    await anon.goto("/signin");
    await anon.getByLabel("Work email").fill(process.env.SHO_ADMIN_EMAIL!);
    await anon.getByLabel("Password").fill(process.env.SHO_ADMIN_PASS!);
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
    const real = await anon.request.post("/api/auth/signin", { data: { email: process.env.SHO_ADMIN_EMAIL, password: "not-the-password-1" } });
    const none = await anon.request.post("/api/auth/signin", { data: { email: `zz-test-${RUN}-ghost2@aplyd.com`, password: "not-the-password-1" } });
    expect(real.status()).toBe(401);
    expect(none.status()).toBe(401);
    expect(await real.json()).toEqual(await none.json());
    expect((await none.json()).error).toBe(WRONG);
    const ok = await anon.request.post("/api/auth/signin", { data: { email: process.env.SHO_ADMIN_EMAIL, password: process.env.SHO_ADMIN_PASS } });
    expect(ok.status()).toBe(200);
  });

  test.skip("AC3: an unverified account with the right password sees Verify your email first with a Resend link", async () => {
    // Needs an unverified account whose password is known; the only way to make one is a real sign-up that emails a real inbox.
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

  test.skip("AC5: a deactivated account with the right password is refused with This account is deactivated", async () => {
    // Needs a deactivated account whose password is known. People added from the Team page get an emailed password nobody can read here.
  });
});
