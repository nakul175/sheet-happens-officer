// SHO-US-1.6 Manage my own profile and sessions (APL-2479). Acceptance criteria AC1 to AC4.
// These change a person's name, password and sessions, so they run on the plain Member account (SHO_MEMBER_EMAIL / SHO_MEMBER_PASS)
// and put the name and password back at the end. They skip when no Member account is configured.
import { test, expect, RUN, zz, login } from "../support";

const PASSWORD_MESSAGE = "Use at least 8 characters, with at least one letter and one number.";

test.describe("SHO-US-1.6 / APL-2479", () => {
  test("AC1: a saved display name shows on the page after reload and on the Team page, and cannot change another person's name", async ({ member, admin, later }) => {
    const original = member.user.name as string;
    later(() => member.api.patch("/api/profile", { name: original }));
    const name = zz("name");
    await member.page.goto("/profile");
    await member.page.getByLabel("Name", { exact: true }).fill(name);
    await member.page.getByRole("button", { name: "Save name" }).click();
    await expect(member.page.getByText("Saved. Your new name shows after the page reloads.")).toBeVisible();
    await member.page.reload();
    await expect(member.page.locator("a.me strong").first()).toHaveText(name);
    const team = (await admin.api.get("/api/team")).json.people as { id: string; name: string }[];
    expect(team.find((p) => p.id === member.user.id)?.name).toBe(name);

    // Prohibited: editing someone else. The route only knows "me", so naming the admin changes nothing.
    const adminBefore = team.find((p) => p.id === admin.user.id)!.name;
    await member.api.patch("/api/profile", { name, id: admin.user.id, userId: admin.user.id });
    const after = (await admin.api.get("/api/team")).json.people as { id: string; name: string }[];
    expect(after.find((p) => p.id === admin.user.id)!.name).toBe(adminBefore);
    // Over the 100-character limit is refused.
    expect((await member.api.patch("/api/profile", { name: "x".repeat(101) })).status).toBe(400);
  });

  test("AC2: changing the password needs the current one, applies the rule, ends other sessions and keeps this one", async ({ member, browser }) => {
    const current = login("MEMBER").password;
    const next = `Zz${RUN}9q`;
    const other = await browser.newContext({
      baseURL: process.env.STAGING_URL ?? "https://staging.sheethappensofficer.com",
      httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    });
    let changed = false;
    try {
      const s = await other.request.post("/api/auth/signin", { data: { email: login("MEMBER").email, password: current } });
      expect(s.ok()).toBe(true);
      expect((await other.request.get("/api/auth/me")).status()).toBe(200);

      // Prohibited: no current password, or a wrong one.
      expect((await member.api.post("/api/profile/password", { password: next, confirm: next })).status).toBe(400);
      expect((await member.api.post("/api/profile/password", { current: "not-it-9x", password: next, confirm: next })).status).toBeGreaterThanOrEqual(400);
      // The rule.
      const weak = await member.api.post("/api/profile/password", { current, password: "short1", confirm: "short1" });
      expect(weak.status).toBe(400);
      expect(JSON.stringify(weak.json)).toContain(PASSWORD_MESSAGE);

      // Through the page.
      await member.page.goto("/profile");
      await member.page.getByLabel("Current password").fill(current);
      await member.page.getByLabel("New password", { exact: true }).fill(next);
      await member.page.getByLabel("Confirm new password").fill(next);
      await member.page.getByRole("button", { name: "Change password" }).click();
      await expect(member.page.getByText("Password changed. You were signed out of your other devices.")).toBeVisible();
      changed = true;

      expect((await other.request.get("/api/auth/me")).status(), "the other session ended").toBe(401);
      expect((await member.api.get("/api/auth/me")).status, "this session stays").toBe(200);
    } finally {
      if (changed) {
        const back = await member.api.post("/api/profile/password", { current: next, password: current, confirm: current });
        expect(back.status, "put the member's password back").toBe(200);
      }
      await other.close();
    }
  });

  test("AC3: Sign out everywhere ends every session, including this one, and goes to Sign in", async ({ member, browser }) => {
    const other = await browser.newContext({
      baseURL: process.env.STAGING_URL ?? "https://staging.sheethappensofficer.com",
      httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    });
    try {
      await other.request.post("/api/auth/signin", { data: { email: login("MEMBER").email, password: login("MEMBER").password } });
      expect((await other.request.get("/api/auth/me")).status()).toBe(200);
      await member.page.goto("/profile");
      await member.page.getByRole("button", { name: "Sign out everywhere" }).click();
      await expect(member.page).toHaveURL(/\/signin/);
      expect((await other.request.get("/api/auth/me")).status()).toBe(401);
      expect((await member.api.get("/api/auth/me")).status).toBe(401);
    } finally {
      await other.close();
    }
  });

  test("AC4: Profile lists my sessions with device and last-active time, marks this one, and shows nobody else's", async ({ member, admin }) => {
    await member.page.goto("/profile");
    const box = member.page.locator("section", { hasText: "Where you are signed in" });
    await expect(box).toBeVisible();
    await expect(box.getByText("This device")).toHaveCount(1);
    await expect(box.getByText(/Last active/).first()).toBeVisible();
    await expect(box.getByText(/(Chrome|Firefox|Safari|Edge|Opera|Browser) on |Unknown device/).first()).toBeVisible();
    const mine = (await member.api.get("/api/profile/sessions")).json.sessions as { id: string; current: boolean }[];
    const theirs = (await admin.api.get("/api/profile/sessions")).json.sessions as { id: string }[];
    expect(mine.filter((s) => s.current)).toHaveLength(1);
    const ids = new Set(theirs.map((s) => s.id));
    expect(mine.some((s) => ids.has(s.id)), "no session of another person is listed").toBe(false);
  });
});
