// SHO-US-1.2 Verify email with a link (APL-2475). Acceptance criteria AC1 to AC4.
// A real verification link only exists in a real inbox, so AC1 and AC3 cannot be driven from here.
import type { Page } from "@playwright/test";
import { test, expect, RUN } from "../support";

const alertOf = (p: Page) => p.locator('[role="alert"]:not(#__next-route-announcer__)');
const ghost = `zz-test-${RUN}-nobody@aplyd.com`; // never has an account

test.describe("SHO-US-1.2 / APL-2475", () => {
  test.skip("AC1: an unused link under 24 hours old verifies the account once, and a second use fails", async () => {
    // Needs the emailed link from a real mailbox. Run by hand after a sign-up.
  });

  test("AC2: an unknown, expired or used link shows the Link expired screen with a way to get a new one, and verifies nobody", async ({ anon }) => {
    const bogus = "x".repeat(40);
    const api = await anon.request.post("/api/auth/verify", { data: { token: bogus } });
    expect(api.status()).toBe(400);
    expect((await api.json()).error).toBe("This link has expired or was already used.");

    await anon.goto(`/verify?token=${bogus}`);
    await expect(anon).toHaveURL(/\/expired/);
    await expect(anon.getByRole("heading", { name: "This link has expired" })).toBeVisible();
    await expect(anon.getByRole("button", { name: "Send a new verification link" })).toBeVisible();
    // Differs (as the story says): with no remembered email the button sends the person to Sign in.
    await anon.getByRole("button", { name: "Send a new verification link" }).click();
    await expect(anon).toHaveURL(/\/signin/);

    await anon.goto("/verify"); // no token at all
    await expect(anon).toHaveURL(/\/expired/);
  });

  test.skip("AC3: asking for a new link emails a new one and kills every earlier link", async () => {
    // Needs two links from a real unverified mailbox to prove the old one stopped working.
  });

  test("AC4: the resend answer is the same for an unknown address and for a verified one, so it reveals nothing", async ({ anon }) => {
    const verified = process.env.SHO_ADMIN_EMAIL!.toLowerCase(); // already verified: no email is sent to it
    test.skip(!/@(aplyd\.com|athenainfonomics\.com)$/.test(verified), "The admin account is not on a sign-up domain.");
    const a = await anon.request.post("/api/auth/resend-verification", { data: { email: ghost } });
    const b = await anon.request.post("/api/auth/resend-verification", { data: { email: verified } });
    expect(a.status()).toBe(200);
    expect(b.status()).toBe(200);
    expect(await b.json()).toEqual(await a.json());
    // Four asks for an address with no account: the answer never changes and never says "no account".
    for (let i = 0; i < 4; i++) {
      const r = await anon.request.post("/api/auth/resend-verification", { data: { email: ghost } });
      expect(r.status()).toBe(200);
      const msg = JSON.stringify(await r.json());
      expect(msg).toContain("try again later");
      expect(msg).not.toMatch(/no account|not found|does not exist/i);
    }
  });

  test.skip("AC4 (limit): the 4th request in an hour sends no email for a real unverified account", async () => {
    // Needs a real unverified account with a mailbox, to count the emails actually sent.
  });
});
