// SHO-US-1.1 Sign up with name, email and password (APL-2474). Acceptance criteria AC1 to AC4.
// Sign-up is only exercised where it is refused: a successful sign-up creates a real unverified account and sends a real
// email to a real company domain, which a staging run must not do.
import type { Page } from "@playwright/test";
import { test, expect, RUN } from "../support";

const alertOf = (p: Page) => p.locator('[role="alert"]:not(#__next-route-announcer__)');
const DOMAIN_MESSAGE = "Use your @aplyd.com or @athenainfonomics.com email address."; // 1.1 AC2 wording, widened by SHO-US-23.1
const PASSWORD_MESSAGE = "Use at least 8 characters, with at least one letter and one number.";
const okPw = `Zz${RUN}9x`; // throw-away value for an account that is never created
const fresh = (tag: string) => `zz-test-${RUN}-${tag}@aplyd.com`;

async function fillSignUp(page: import("@playwright/test").Page, name: string, email: string, password: string) {
  await page.goto("/signup");
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
}

test.describe("SHO-US-1.1 / APL-2474", () => {
  test.skip("AC1: a valid new @aplyd.com sign-up creates an unverified account and shows Check your email", async () => {
    // Needs a real mailbox to receive and read the verification link, and would create a real account. Run by hand.
  });

  test("AC2: a look-alike or foreign domain is refused on the page and on the server, and nothing is created", async ({ anon, admin }) => {
    await fillSignUp(anon, "ZZ-TEST Domain", `zz-test-${RUN}-dom@aplyd.co`, okPw);
    await expect(alertOf(anon)).toContainText(DOMAIN_MESSAGE);
    await expect(anon).toHaveURL(/\/signup/);
    for (const email of [`zz-test-${RUN}@aplyd.co`, `zz-test-${RUN}@aplyd.com.example.net`, `zz-test-${RUN}@mail.aplyd.com`, `zz-test-${RUN}@gmail.com`]) {
      // Straight to the API, so a browser-only check would not pass this.
      const r = await anon.request.post("/api/auth/signup", { data: { name: "ZZ-TEST Domain", email, password: okPw } });
      expect(r.status(), email).toBe(400);
      expect(JSON.stringify(await r.json()), email).toContain(DOMAIN_MESSAGE);
    }
    const team = (await admin.api.get("/api/team")).json.people as { email: string }[];
    expect(team.some((p) => p.email.startsWith(`zz-test-${RUN}@`))).toBe(false);
  });

  test("AC3: an email that already has an account is refused with a Sign in link, and no second account appears", async ({ anon, admin }) => {
    const email = String(admin.user.email).toLowerCase();
    test.skip(!/@(aplyd\.com|athenainfonomics\.com)$/.test(email), "The admin account is not on a sign-up domain, so the domain rule answers first.");
    await fillSignUp(anon, "ZZ-TEST Again", email, okPw);
    const alert = alertOf(anon);
    await expect(alert).toContainText("An account with this email already exists.");
    await expect(alert.getByRole("link", { name: "Sign in" })).toBeVisible();
    const people = (await admin.api.get("/api/team")).json.people as { email: string }[];
    expect(people.filter((p) => p.email.toLowerCase() === email)).toHaveLength(1);
  });

  test("AC4: weak passwords show the rule and create nothing", async ({ anon }) => {
    const weak = ["short1", "onlyletters", "12345678", "a".repeat(129) + "1"];
    await fillSignUp(anon, "ZZ-TEST Weak", fresh("weak"), weak[0]);
    await expect(alertOf(anon)).toContainText(PASSWORD_MESSAGE);
    for (const password of weak) {
      const r = await anon.request.post("/api/auth/signup", { data: { name: "ZZ-TEST Weak", email: fresh("weak"), password } });
      expect(r.status()).toBe(400);
      expect(JSON.stringify(await r.json())).toContain(PASSWORD_MESSAGE);
    }
    // Had any of those created an account, a second try would now say "already exists" instead of the rule.
    const again = await anon.request.post("/api/auth/signup", { data: { name: "ZZ-TEST Weak", email: fresh("weak"), password: "short1" } });
    expect(again.status()).toBe(400);
  });
});
