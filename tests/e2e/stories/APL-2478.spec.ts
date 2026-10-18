// SHO-US-1.5 Stay signed in, sign out, and retire the email-only session (APL-2478). Acceptance criteria AC1 to AC3.
import { test, expect } from "../support";

test.describe("SHO-US-1.5 / APL-2478", () => {
  test("AC1: a signed-in person stays signed in on return, and the 30 days run from sign-in, not from activity", async ({ anon }) => {
    const r = await anon.request.post("/api/auth/signin", { data: { email: process.env.SHO_ADMIN_EMAIL, password: process.env.SHO_ADMIN_PASS } });
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

  test.skip("AC1 (after 30 days): the session ends 30 days after sign-in, and a deactivated person's session is not extended", async () => {
    // Needs 30 days to pass, or a clock the test controls on the server.
  });

  test("AC2: Sign out ends the session and protected screens send the person to Sign in", async ({ anon }) => {
    await anon.request.post("/api/auth/signin", { data: { email: process.env.SHO_ADMIN_EMAIL, password: process.env.SHO_ADMIN_PASS } });
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
    const email = process.env.SHO_ADMIN_EMAIL!;
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
