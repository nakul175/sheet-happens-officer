// SHO-US-23.5 Temporary password must be changed at first sign-in (APL-2624). Acceptance criteria AC1 to AC7.
// Added people are ZZ-TEST names on nakul17+ aliases. The emailed password is read from the test mail sink.
// SHO-US-23.5 is not in this tree. Tests of the forced wall are annotated with test.fail when the run shows the old banner behaviour.
import { test, expect, login } from "../support";
import { alias, RUN, mailedPassword, nextPass, waitForSinkMail, signInAs, deactivate, PASS, passwordOk, type Api } from "./qa";

async function added(admin: { api: Api }, later: (fn: () => Promise<unknown>) => void, tag: string) {
  const email = alias("2624", tag, "aplyd.com");
  const created = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `${tag} ${RUN}`, email, role: "MEMBER" });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const id = created.json.person!.id;
  later(() => deactivate(admin.api, id));
  const pass = mailedPassword(email) ?? (await waitForSinkMail(email, "Your Sheet Happens Officer account")).text?.match(/^Password: (.+)$/m)?.[1];
  expect(pass, "emailed password").toBeTruthy();
  return { id, email, pass: pass! };
}

// This build still ships SHO-E23 D2 (closable banner, emailed password stays valid).
// SHO-US-23.5 / APL-2624 (PR #8) is not merged, so the forced wall is a known product gap, not a new defect.
const UNBUILT = "Product gap: forced password change (SHO-US-23.5 / APL-2624) is not in this build. PR #8 is not merged. The app still shows a closable banner and the emailed password stays valid (SHO-E23 D2).";

test.describe("SHO-US-23.5 / APL-2624", () => {
  test.beforeAll(() => {
    test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
    test.skip(!passwordOk(PASS), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
    try { login("ADMIN"); } catch { test.skip(true, "Set SHO_ADMIN_EMAIL and SHO_ADMIN_PASS (a Super Admin)."); }
  });

  test("AC1: after signing in with a Super-Admin-issued password, every screen but 'Set your own password' and sign-out is blocked", async ({ admin, browser, later }) => {
    test.fail(true, UNBUILT);
    const p = await added(admin, later, "ac1");
    const who = await signInAs(browser, p.email, p.pass);
    later(() => who.ctx.close());
    for (const url of ["/", "/projects", "/team", "/profile", "/search"]) {
      await who.page.goto(url);
      await expect(who.page.getByRole("heading", { name: "Set your own password" }), url).toBeVisible();
      await expect(who.page.getByRole("button", { name: "Sign out" }), url).toBeVisible();
      await expect(who.page.locator('[aria-label="Main"]'), url).toHaveCount(0);
      await expect(who.page.getByRole("button", { name: "Close this message" }), url).toHaveCount(0);
    }
  });

  test("AC2: a new password that meets the rules opens the asked-for page, clears the forced state, and the emailed password stops working", async ({ admin, browser, later }) => {
    test.fail(true, UNBUILT);
    const p = await added(admin, later, "ac2");
    const who = await signInAs(browser, p.email, p.pass);
    later(() => who.ctx.close());
    await who.page.goto("/projects");
    await expect(who.page.getByRole("heading", { name: "Set your own password" })).toBeVisible();
    const weak = await who.api.post("/api/profile/password", { current: p.pass, password: "short1", confirm: "short1" });
    expect(weak.status).toBe(400);
    const updated = nextPass(p.pass);
    await who.page.getByLabel("Emailed password").fill(p.pass);
    await who.page.getByLabel("New password", { exact: true }).fill(updated);
    await who.page.getByLabel("Confirm new password").fill(updated);
    await who.page.getByRole("button", { name: "Save and continue" }).click();
    await expect(who.page.locator('[aria-label="Main"]:visible').first()).toBeVisible();
    await expect(who.page.getByRole("heading", { name: "Set your own password" })).toHaveCount(0);
    expect((await who.api.get("/api/auth/me")).json.user.mustChangePassword).toBe(false);
    expect((await who.api.get("/api/projects")).status).toBe(200);
    const oldCtx = await browser.newContext();
    later(() => oldCtx.close());
    expect((await oldCtx.request.post("/api/auth/signin", { data: { email: p.email, password: p.pass } })).status()).toBe(401);
  });

  test("AC3: a new password equal to the emailed one is refused with 'Choose a new password. It cannot be the one we emailed you.'", async ({ admin, browser, later }) => {
    test.fail(true, UNBUILT);
    const p = await added(admin, later, "ac3");
    const who = await signInAs(browser, p.email, p.pass);
    later(() => who.ctx.close());
    const same = await who.api.post("/api/profile/password", { current: p.pass, password: p.pass, confirm: p.pass });
    expect(same.status).toBe(400);
    expect(same.json.error).toBe("Choose a new password. It cannot be the one we emailed you.");
    expect((await who.api.get("/api/auth/me")).json.user.mustChangePassword).toBe(true);
    expect((await who.api.get("/api/projects")).status).toBe(403);
    expect((await who.api.get("/api/projects")).json.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  test("AC4: in the forced state every app API but change-password, sign-out and me answers 403 PASSWORD_CHANGE_REQUIRED", async ({ admin, browser, later }) => {
    test.fail(true, UNBUILT);
    const p = await added(admin, later, "ac4");
    const who = await signInAs(browser, p.email, p.pass);
    later(() => who.ctx.close());
    const calls: [string, string, unknown?][] = [
      ["GET", "/api/projects"],
      ["GET", "/api/my-tasks"],
      ["GET", "/api/team"],
      ["GET", `/api/team/${p.id}`],
      ["GET", "/api/notifications"],
      ["GET", "/api/search?q=zz"],
      ["PATCH", "/api/profile"],
      ["GET", "/api/profile/sessions"],
    ];
    for (const [method, url, body] of calls) {
      const r = await who.ctx.request.fetch(url, { method, data: body });
      const json = await r.json().catch(() => ({})) as { error?: string; code?: string };
      expect(r.status(), `${method} ${url}`).toBe(403);
      expect(json.code, `${method} ${url}`).toBe("PASSWORD_CHANGE_REQUIRED");
      expect(json.error).toBe("Set your own password first.");
    }
    const me = await who.api.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.json.user.mustChangePassword).toBe(true);
    expect((await who.api.post("/api/profile/password", { current: "wrong-pass-1", password: nextPass(p.pass), confirm: nextPass(p.pass) })).status).toBe(400);
    expect((await who.ctx.request.post("/api/auth/signout")).status()).toBe(204);
    expect((await who.api.get("/api/auth/me")).status).toBe(401);
  });

  test("AC5: Resend sign-in details puts the person back in the forced state for the new password", async ({ admin, browser, later }) => {
    test.fail(true, UNBUILT);
    const p = await added(admin, later, "ac5");
    const who = await signInAs(browser, p.email, p.pass);
    later(() => who.ctx.close());
    const updated = nextPass(p.pass);
    expect((await who.api.post("/api/profile/password", { current: p.pass, password: updated, confirm: updated })).status).toBe(200);
    expect((await admin.api.post(`/api/team/${p.id}/resend`)).status).toBe(200);
    const second = (await waitForSinkMail(p.email, "Your Sheet Happens Officer account")).text?.match(/^Password: (.+)$/m)?.[1];
    expect(second && second !== p.pass).toBe(true);
    const again = await signInAs(browser, p.email, second!);
    later(() => again.ctx.close());
    expect((await again.api.get("/api/auth/me")).json.user.mustChangePassword).toBe(true);
    const blocked = await again.api.get("/api/my-tasks");
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await again.api.post("/api/profile/password", { current: second, password: second, confirm: second })).status).toBe(400);
  });

  test("AC6 (own password): a person who set their own password is never forced", async ({ admin }) => {
    // Runs on the current build as a guard: the Super Admin signed in with their own password reaches every screen and API.
    const me = await admin.api.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.json.user.mustChangePassword ?? false).toBe(false);
    for (const p of ["/api/projects", "/api/my-tasks", "/api/team"]) expect((await admin.api.get(p)).status, p).toBe(200);
    for (const url of ["/", "/projects", "/profile"]) {
      await admin.page.goto(url);
      await expect(admin.page.locator('[aria-label="Main"]:visible').first(), url).toBeVisible();
      await expect(admin.page.getByRole("heading", { name: "Set your own password" }), url).toHaveCount(0);
    }
  });

  test("AC6 (Forgot password): a person who reset their password by email is never forced", async ({ anon, admin, browser, later }) => {
    const p = await added(admin, later, "ac6");
    expect((await anon.request.post("/api/auth/forgot-password", { data: { email: p.email } })).ok()).toBe(true);
    const link = await waitForSinkMail(p.email, "Reset");
    const updated = nextPass(p.pass);
    const reset = await anon.request.post("/api/auth/reset-password", { data: { token: link.token, password: updated, confirm: updated } });
    expect(reset.ok(), await reset.text()).toBe(true);
    const who = await signInAs(browser, p.email, updated);
    later(() => who.ctx.close());
    const me = await who.api.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.json.user.mustChangePassword ?? false).toBe(false);
    expect((await who.api.get("/api/projects")).status).toBe(200);
    await who.page.goto("/");
    await expect(who.page.getByRole("heading", { name: "Set your own password" })).toHaveCount(0);
    await expect(who.page.locator('[aria-label="Main"]:visible').first()).toBeVisible();
  });

  test("AC7 (Add person): the dialog says the person must replace the password at first sign-in, not that it stays valid", async ({ admin }) => {
    test.fail(true, UNBUILT);
    await admin.page.goto("/team");
    await admin.page.getByRole("button", { name: /Add person/ }).click();
    const dlg = admin.page.getByRole("dialog");
    await expect(dlg).toContainText("The person must replace it with their own when they first sign in.");
    await expect(dlg).not.toContainText(/stays valid/i);
    await dlg.getByRole("button", { name: "Cancel" }).click();
  });

  test("AC7 (email and banner): the email says the password is temporary and the closable banner is gone", async ({ admin, browser, later }) => {
    test.fail(true, UNBUILT);
    const p = await added(admin, later, "ac7");
    const text = (await waitForSinkMail(p.email, "Your Sheet Happens Officer account")).text ?? "";
    expect(text).not.toMatch(/stays valid/i);
    expect(text).toContain("This password is temporary. When you sign in, you will be asked to set your own password before you can do anything else.");
    const who = await signInAs(browser, p.email, p.pass);
    later(() => who.ctx.close());
    await who.page.goto("/");
    await expect(who.page.getByRole("button", { name: "Close this message" })).toHaveCount(0);
    await expect(who.page.getByRole("heading", { name: "Set your own password" })).toBeVisible();
  });
});
