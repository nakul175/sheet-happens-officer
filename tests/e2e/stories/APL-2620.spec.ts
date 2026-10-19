// SHO-US-23.1 Two company domains can sign up (APL-2620). Acceptance criteria AC1 to AC4.
// Sign-up uses a nakul17+ alias. The verification link is read from the test mail sink, and the account is deactivated afterwards.
import type { Page } from "@playwright/test";
import { test, expect, RUN, login } from "../support";
import { PASS, passwordOk, alias, zz, signUp, personByEmail, deactivate, waitForSinkMail } from "./qa";

const alertOf = (p: Page) => p.locator('[role="alert"]:not(#__next-route-announcer__)');
const MESSAGE = "Use your @aplyd.com or @athenainfonomics.com email address.";
const pw = `Zz${RUN}9x`;
const refused = [`zz-test-${RUN}@mail.aplyd.com`, `zz-test-${RUN}@athenainfonomics.com.evil.com`, `zz-test-${RUN}@gmail.com`, `zz-test-${RUN}@aplyd.co`];

test.describe("SHO-US-23.1 / APL-2620 qa:TC missing", () => {
  test.beforeAll(() => {
    test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
    test.skip(!passwordOk(PASS), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
    try { login("ADMIN"); } catch { test.skip(true, "Set SHO_ADMIN_EMAIL and SHO_ADMIN_PASS (a Super Admin)."); }
  });

  // qa:TC missing
  test("AC1: forgot-password and resend-verification accept aplyd.com and athenainfonomics.com qa:TC missing", { annotation: { type: "qa:TC", description: "missing" } }, async ({ anon }) => {
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

  // qa:TC missing
  test("AC1 (sign-up): an @athenainfonomics.com colleague signs up and gets the verification email qa:TC missing", { annotation: { type: "qa:TC", description: "missing" } }, async ({ anon, admin, later }) => {
    test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
    test.skip(!passwordOk(PASS), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
    const email = alias("2620", "ac1", "athenainfonomics.com");
    const signed = await signUp(anon.request, zz("athena"), email);
    expect(signed.status, signed.body).toBe(201);
    expect(signed.json.status).toBe("check_email");
    const person = await personByEmail(admin.api, email);
    expect(person?.status).toBe("UNVERIFIED");
    later(() => deactivate(admin.api, person!.id));
    const mail = await waitForSinkMail(email, "Verify");
    expect(mail.to?.toLowerCase()).toBe(email.toLowerCase());
    expect(mail.text).toContain("/verify?token=");
    expect((await anon.request.get("/api/auth/me")).status(), "sign-up does not sign them in").toBe(401);
  });

  // qa:TC missing
  test("AC2: look-alike and foreign domains are refused with the new message on sign-up, resend and forgot password qa:TC missing", { annotation: { type: "qa:TC", description: "missing" } }, async ({ anon }) => {
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

  // qa:TC missing
  test("AC3: sign-in is unchanged, so a wrong-domain email fails like any other qa:TC missing", { annotation: { type: "qa:TC", description: "missing" } }, async ({ anon }) => {
    const wrongDomain = await anon.request.post("/api/auth/signin", { data: { email: `zz-test-${RUN}-d@gmail.com`, password: "not-a-real-one-1" } });
    const unknown = await anon.request.post("/api/auth/signin", { data: { email: `zz-test-${RUN}-e@aplyd.com`, password: "not-a-real-one-1" } });
    expect(wrongDomain.status()).toBe(401);
    expect(unknown.status()).toBe(401);
    expect(await wrongDomain.json()).toEqual(await unknown.json());
    expect((await unknown.json()).error).toBe("Email or password is incorrect.");
  });

  // qa:TC missing
  test("AC4: existing accounts and the Super Admin are untouched qa:TC missing", { annotation: { type: "qa:TC", description: "missing" } }, async ({ anon, admin }) => {
    const r = await anon.request.post("/api/auth/signin", { data: { email: login("ADMIN").email, password: login("ADMIN").password } });
    expect(r.status()).toBe(200);
    expect((await r.json()).user.orgRole).toBe("SUPER_ADMIN");
    const people = (await admin.api.get("/api/team")).json.people as { orgRole: string }[];
    expect(people.length).toBeGreaterThan(1);
    expect(people.filter((p) => p.orgRole === "SUPER_ADMIN").length).toBeGreaterThanOrEqual(1);
  });
});
