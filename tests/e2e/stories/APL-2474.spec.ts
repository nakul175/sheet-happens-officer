// SHO-US-1.1 Sign up with name, email and password (APL-2474). Acceptance criteria AC1 to AC4.
// A successful sign-up uses a nakul17+ alias and SHO_QA_PASS. The verification link is read from the test mail sink.
// Names use ZZ-TEST. The account is deactivated afterwards.
import type { Page } from "@playwright/test";
import { test, expect, RUN, login } from "../support";
import { PASS, passwordOk, alias, zz, signUp, personByEmail, deactivate, waitForSinkMail } from "./qa";

const alertOf = (p: Page) => p.locator('[role="alert"]:not(#__next-route-announcer__)');
const DOMAIN_MESSAGE = "Use your @aplyd.com or @athenainfonomics.com email address."; // 1.1 AC2 wording, widened by SHO-US-23.1
const PASSWORD_MESSAGE = "Use at least 8 characters, with at least one letter and one number.";
const okPw = `Zz${RUN}9x`; // throw-away value for an account that is never created
const fresh = (tag: string) => `zz-test-${RUN}-${tag}@aplyd.com`;

function needPass() {
  test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  test.skip(!passwordOk(PASS), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
}

async function fillSignUp(page: Page, name: string, email: string, password: string) {
  await page.goto("/signup");
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
}

test.describe("SHO-US-1.1 / APL-2474", () => {
  test.beforeAll(() => {
    test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
    test.skip(!passwordOk(PASS), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
    try { login("ADMIN"); } catch { test.skip(true, "Set SHO_ADMIN_EMAIL and SHO_ADMIN_PASS (a Super Admin)."); }
  });

  test("AC1: a valid new @aplyd.com or @athenainfonomics.com sign-up creates an unverified account and shows Check your email", async ({ anon, admin, later }) => {
    needPass();
    try { login("ADMIN"); } catch { test.skip(true, "Set SHO_ADMIN_EMAIL and SHO_ADMIN_PASS (a Super Admin)."); }
    for (const domain of ["aplyd.com", "athenainfonomics.com"] as const) {
      const email = alias("2474", `ac1-${domain.split(".")[0]}`, domain);
      const name = zz(`ac1 ${domain.split(".")[0]}`);
      await fillSignUp(anon, name, email, PASS);
      await expect(anon).toHaveURL(/\/check-email/);
      await expect(anon.getByRole("heading", { name: "Check your email" })).toBeVisible();
      expect((await anon.request.get("/api/auth/me")).status(), "sign-up must not sign the person in").toBe(401);
      const person = await personByEmail(admin.api, email);
      expect(person?.status, email).toBe("UNVERIFIED");
      later(() => deactivate(admin.api, person!.id));
      const mail = await waitForSinkMail(email, "Verify");
      expect(mail.to?.toLowerCase()).toBe(email.toLowerCase());
      expect(mail.text).toContain("/verify?token=");
    }
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

  test("AC3: an email that already has an account is refused with a Sign in link, and no second account appears", async ({ anon, admin, later }) => {
    needPass();
    const email = alias("2474", "ac3", "aplyd.com");
    const signed = await signUp(anon.request, zz("ac3"), email);
    expect(signed.status, signed.body).toBe(201);
    const person = await personByEmail(admin.api, email);
    expect(person?.status).toBe("UNVERIFIED");
    later(() => deactivate(admin.api, person!.id));

    await fillSignUp(anon, "ZZ-TEST Again", email, PASS);
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
