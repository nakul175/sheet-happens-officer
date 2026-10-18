// SHO-US-1.5 Stay signed in, sign out, and retire the email-only session (APL-2478). Acceptance criteria AC1 to AC3.
import { test, expect, login } from "../support";
import { PASS, passwordOk, alias, zz, signUp, personByEmail, deactivate, waitForSinkMail, signInAs, expireLocalSessions } from "./qa";

test.describe("SHO-US-1.5 / APL-2478", () => {
  test("AC1: a signed-in person stays signed in on return, and the 30 days run from sign-in, not from activity", async ({ anon }) => {
    const r = await anon.request.post("/api/auth/signin", { data: { email: login("ADMIN").email, password: login("ADMIN").password } });
    expect(r.status()).toBe(200);
    const cookie = async () => (await anon.context().cookies()).find((c) => c.name === "sho_session")!;
    const before = await cookie();
    const days = (before.expires - Date.now() / 1000) / 86400;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30.1);

    await anon.goto("/");
    await anon.reload();
    await anon.goto("/team");
    await expect(anon).toHaveURL(/\/team/);
    expect((await anon.request.get("/api/auth/me")).status()).toBe(200);
    expect((await cookie()).expires, "activity must not extend the session").toBe(before.expires);
    await anon.request.post("/api/auth/signout");
  });

  test("AC1 (after 30 days): the session ends 30 days after sign-in, and a deactivated person's session is not extended", async ({ anon, admin, browser, later }) => {
    test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
    test.skip(!passwordOk(PASS), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
    const email = alias("2478", "ac1", "aplyd.com");
    expect((await signUp(anon.request, zz("ac1"), email)).status).toBe(201);
    const token = (await waitForSinkMail(email, "Verify")).token;
    expect((await anon.request.post("/api/auth/verify", { data: { token } })).ok()).toBe(true);
    const person = await personByEmail(admin.api, email);
    later(() => deactivate(admin.api, person!.id));

    const who = await signInAs(browser, email, PASS);
    later(() => who.ctx.close());
    const cookie = () => who.ctx.cookies().then((all) => all.find((c) => c.name === "sho_session"));
    const before = (await cookie())!;
    const days = (before.expires - Date.now() / 1000) / 86400;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30.1);
    await who.page.goto("/");
    await who.page.reload();
    expect((await cookie())?.expires, "activity must not extend the 30 days").toBe(before.expires);

    // The server stores the same fixed end. A local run moves that end into the past; the cookie is still sent.
    const expired = await expireLocalSessions(email);
    if (expired) {
      expect((await who.api.get("/api/auth/me")).status, "a session past its 30 days is signed out").toBe(401);
      expect((await cookie())?.expires, "expiry is not extended when the session ends").toBe(before.expires);
    }

    const again = await signInAs(browser, email, PASS);
    later(() => again.ctx.close());
    const live = (await again.ctx.cookies()).find((c) => c.name === "sho_session")!;
    expect((await admin.api.post(`/api/team/${person!.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
    expect((await again.api.get("/api/auth/me")).status, "a deactivated person is signed out").toBe(401);
    const after = (await again.ctx.cookies()).find((c) => c.name === "sho_session");
    if (after) expect(after.expires, "deactivation must not extend the session").toBeLessThanOrEqual(live.expires);
    expect((await anon.request.post("/api/auth/signin", { data: { email, password: PASS } })).status()).toBe(403);
  });

  test("AC2: Sign out ends the session and protected screens send the person to Sign in", async ({ anon }) => {
    await anon.request.post("/api/auth/signin", { data: { email: login("ADMIN").email, password: login("ADMIN").password } });
    await anon.goto("/profile");
    await expect(anon.getByRole("heading", { name: "Profile" }).first()).toBeVisible();
    await anon.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(anon).toHaveURL(/\/signin/);
    for (const path of ["/", "/projects", "/team", "/profile"]) {
      await anon.goto(path);
      await expect(anon, path).toHaveURL(/\/signin/);
    }
    expect((await anon.request.get("/api/auth/me")).status()).toBe(401);
  });

  test("AC3: no endpoint signs a person in with an email alone", async ({ anon }) => {
    const email = login("ADMIN").email;
    // The sign-in route needs a password.
    const noPw = await anon.request.post("/api/auth/signin", { data: { email } });
    expect(noPw.status()).toBe(400);
    // The old Layer 1 find-or-create paths no longer exist and never set a session.
    for (const path of ["/api/session", "/api/users", "/api/login", "/api/auth/login", "/api/auth/session", "/api/auth/email-signin"]) {
      const r = await anon.request.post(path, { data: { email } });
      expect([404, 405], path).toContain(r.status());
      expect(r.headers()["set-cookie"] ?? "", path).not.toContain("sho_session");
    }
    expect((await anon.request.get("/api/auth/me")).status()).toBe(401);
    expect((await anon.context().cookies()).some((c) => c.name === "sho_session" || c.name === "tb_uid")).toBe(false);
  });
});
