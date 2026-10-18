// SHO-US-23.1 Two company domains can sign up (APL-2620). Acceptance criteria AC1 to AC4.
// A successful sign-up creates a real unverified account and emails a real domain, so AC1 is checked on the two routes that create nothing
// (forgot password, resend verification) and the sign-up itself is left to a manual run.
import type { Page } from "@playwright/test";
import { test, expect, RUN, login } from "../support";
import { why } from "../helpers/jim-http";

const alertOf = (p: Page) => p.locator('[role="alert"]:not(#__next-route-announcer__)');
const MESSAGE = "Use your @aplyd.com or @athenainfonomics.com email address.";
const pw = `Zz${RUN}9x`;
const refused = [`zz-test-${RUN}@mail.aplyd.com`, `zz-test-${RUN}@athenainfonomics.com.evil.com`, `zz-test-${RUN}@gmail.com`, `zz-test-${RUN}@aplyd.co`];

test.describe("SHO-US-23.1 / APL-2620", () => {
  test("AC1: forgot-password and resend-verification accept aplyd.com and athenainfonomics.com", async ({ anon }) => {
    for (const email of [`zz-test-${RUN}-a@aplyd.com`, `zz-test-${RUN}-b@athenainfonomics.com`]) {
      for (const path of ["/api/auth/forgot-password", "/api/auth/resend-verification"]) {
        const r = await anon.request.post(path, { data: { email } });
        expect(r.status(), `${path} ${email}`).toBe(200); // neutral answer: no such account, nothing sent
      }
    }
    await anon.goto("/forgot");
    await anon.getByLabel("Work email").fill(`zz-test-${RUN}-c@athenainfonomics.com`);
    await anon.getByRole("button", { name: "Send reset link" }).click();
    await expect(anon).toHaveURL(/\/check-reset/);
  });

  test.skip("AC1 (sign-up): an @athenainfonomics.com colleague signs up and gets the verification email", why(
    "Creates a real unverified account and sends a verification email to a real company mailbox. A browser session cannot read that inbox.",
  ), async () => {});

  test("AC2: look-alike and foreign domains are refused with the new message on sign-up, resend and forgot password", async ({ anon }) => {
    for (const email of refused) {
      for (const [path, data] of [
        ["/api/auth/signup", { name: "ZZ-TEST Domain", email, password: pw }],
        ["/api/auth/resend-verification", { email }],
        ["/api/auth/forgot-password", { email }],
      ] as const) {
        const r = await anon.request.post(path, { data });
        expect(r.status(), `${path} ${email}`).toBe(400);
        expect(JSON.stringify(await r.json()), `${path} ${email}`).toContain(MESSAGE);
      }
    }
    await anon.goto("/signup");
    await anon.getByLabel("Full name").fill("ZZ-TEST Domain");
    await anon.getByLabel("Work email").fill(refused[1]);
    await anon.getByLabel("Password").fill(pw);
    await anon.getByRole("button", { name: "Create account" }).click();
    await expect(alertOf(anon)).toContainText(MESSAGE);
  });

  test("AC3: sign-in is unchanged, so a wrong-domain email fails like any other", async ({ anon }) => {
    const wrongDomain = await anon.request.post("/api/auth/signin", { data: { email: `zz-test-${RUN}-d@gmail.com`, password: "not-a-real-one-1" } });
    const unknown = await anon.request.post("/api/auth/signin", { data: { email: `zz-test-${RUN}-e@aplyd.com`, password: "not-a-real-one-1" } });
    expect(wrongDomain.status()).toBe(401);
    expect(unknown.status()).toBe(401);
    expect(await wrongDomain.json()).toEqual(await unknown.json());
    expect((await unknown.json()).error).toBe("Email or password is incorrect.");
  });

  test("AC4: existing accounts and the Super Admin are untouched", async ({ anon, admin }) => {
    const r = await anon.request.post("/api/auth/signin", { data: { email: login("ADMIN").email, password: login("ADMIN").password } });
    expect(r.status()).toBe(200);
    expect((await r.json()).user.orgRole).toBe("SUPER_ADMIN");
    const people = (await admin.api.get("/api/team")).json.people as { orgRole: string }[];
    expect(people.length).toBeGreaterThan(1);
    expect(people.filter((p) => p.orgRole === "SUPER_ADMIN").length).toBeGreaterThanOrEqual(1);
  });
});
