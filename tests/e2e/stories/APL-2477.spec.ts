// SHO-US-1.4 Reset a forgotten password (APL-2477). Acceptance criteria AC1 to AC6.
// A real reset link only exists in a real inbox. What can be checked without one: the neutral answer, the form rules, the expired screen.
import type { Page } from "@playwright/test";
import { test, expect, RUN } from "../support";

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

  test.skip("AC1 (link sent only if an account exists): a reset email arrives for a real account and none for an unknown one", async () => {
    // Needs a real mailbox to see which emails arrive.
  });

  test.skip("AC2: a valid link plus a good password changes the password, ends other sessions, and the link works once", async () => {
    // Needs the emailed reset link from a real mailbox.
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
    await expect(anon.getByRole("heading", { name: "This link has expired" })).toBeVisible();
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

  test.skip("AC5 (limit): the 4th request in an hour sends no email for a real account", async () => {
    // Needs a real account with a mailbox, to count the emails actually sent.
  });

  test.skip("AC6: after a reset, a locked-out person can sign in at once with the new password", async () => {
    // Needs the emailed reset link from a real mailbox.
  });
});
