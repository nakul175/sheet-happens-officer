// SHO-US-23.3 New person gets sign-in details by email (APL-2622). Acceptance criteria AC1 to AC5.
// The emailed password is read from the test mail sink. People are ZZ-TEST names at an .invalid address and are deactivated afterwards.
import { test, expect, RUN, BASE_URL, login, type Json } from "../support";
import { mailedPassword, nextPass, waitForSinkMail, signInAs, PASS, passwordOk } from "./qa";

const mk = async (admin: { api: { post: (p: string, b?: unknown) => Promise<{ status: number; json: Json }>; get: (p: string) => Promise<{ status: number; json: Json }> } }, later: (f: () => Promise<unknown>) => void, label: string) => {
  const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `${label} ${RUN}`, email: `zz-test-${RUN}-${label}@example.invalid`, role: "MEMBER" });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.person.id as string;
  later(async () => { if ((await admin.api.get(`/api/team/${id}`)).json.person?.status !== "DEACTIVATED") await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }); });
  return { id, name: `ZZ-TEST ${label} ${RUN}`, email: `zz-test-${RUN}-${label}@example.invalid` };
};

test.describe("SHO-US-23.3 / APL-2622", () => {
  test.beforeAll(() => {
    test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
    test.skip(!passwordOk(PASS), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
    try { login("ADMIN"); } catch { test.skip(true, "Set SHO_ADMIN_EMAIL and SHO_ADMIN_PASS (a Super Admin)."); }
  });

  // qa:TC missing
  test("AC1: the email shows the sign-in link, the username and the password", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin, later }) => {
    const p = await mk(admin, later, "mail");
    const mail = await waitForSinkMail(p.email, "Your Sheet Happens Officer account");
    expect(mail.text).toContain("/signin");
    expect(mail.text).toContain(`Username: ${p.email}`);
    expect(mail.text).toMatch(/^Password: \S+$/m);
    const pass = mail.text?.match(/^Password: (.+)$/m)?.[1] ?? "";
    expect(JSON.stringify((await admin.api.get(`/api/team/${p.id}`)).json).includes(pass)).toBe(false);
  });

  // qa:TC missing
  test("AC2: the password stays valid until the person changes it", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin, browser, later }) => {
    const p = await mk(admin, later, "keep");
    const pass = mailedPassword(p.email) ?? (await waitForSinkMail(p.email, "Your Sheet Happens Officer account")).text?.match(/^Password: (.+)$/m)?.[1];
    expect(pass, "emailed password").toBeTruthy();
    const first = await signInAs(browser, p.email, pass!);
    later(() => first.ctx.close());
    expect((await first.api.get("/api/auth/me")).status).toBe(200);
    await first.ctx.close();
    const second = await signInAs(browser, p.email, pass!);
    later(() => second.ctx.close());
    const updated = nextPass(pass!);
    const changed = await second.api.post("/api/profile/password", { current: pass, password: updated, confirm: updated });
    expect(changed.status, JSON.stringify(changed.json)).toBe(200);
    const fresh = await browser.newContext({ baseURL: BASE_URL });
    later(() => fresh.close());
    expect((await fresh.request.post("/api/auth/signin", { data: { email: p.email, password: pass } })).status()).toBe(401);
    const ok = await fresh.request.post("/api/auth/signin", { data: { email: p.email, password: updated } });
    const body = await ok.text();
    expect(body.includes(updated)).toBe(false);
    expect(ok.status()).toBe(200);
  });

  // qa:TC missing
  test("AC3: the first sign-in shows a closable 'Set your own password' banner linking to Profile", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin, browser, later }) => {
    const p = await mk(admin, later, "banner");
    const pass = (await waitForSinkMail(p.email, "Your Sheet Happens Officer account")).text?.match(/^Password: (.+)$/m)?.[1];
    expect(pass).toBeTruthy();
    const who = await signInAs(browser, p.email, pass!);
    later(() => who.ctx.close());
    await who.page.goto("/");
    const bar = who.page.getByRole("status").filter({ hasText: "Set your own password" });
    await expect(bar).toBeVisible();
    await expect(bar).toContainText("The emailed one still works until you do.");
    await expect(bar.getByRole("link", { name: "Change password" })).toHaveAttribute("href", "/profile");
    await bar.getByRole("button", { name: "Close this message" }).click();
    await expect(bar).toHaveCount(0);
    await who.page.reload();
    await expect(who.page.getByRole("status").filter({ hasText: "Set your own password" })).toHaveCount(0);
  });

  // qa:TC missing
  test("AC4: Resend sign-in details answers with an emailed/not-emailed flag only, never a password, and is for the Super Admin only", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin, member, later }) => {
    const p = await mk(admin, later, "resend");
    const r = await admin.api.post(`/api/team/${p.id}/resend`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(Object.keys(r.json)).toEqual(["emailSent"]);
    expect(typeof r.json.emailSent).toBe("boolean");
    expect(JSON.stringify(r.json).toLowerCase().includes("password")).toBe(false);
    expect((await admin.api.get(`/api/team/${p.id}`)).json.person.status).toBe("ACTIVE");
    // Only the Super Admin; not yourself; not someone deactivated.
    expect((await member.api.post(`/api/team/${p.id}/resend`)).status).toBe(403);
    const self = await admin.api.post(`/api/team/${admin.user.id}/resend`);
    expect(self.status).toBe(409);
    expect(self.json.error).toBe("Use Profile to change your own password.");
    expect((await admin.api.post(`/api/team/${p.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
    const dead = await admin.api.post(`/api/team/${p.id}/resend`);
    expect(dead.status).toBe(409);
    expect(dead.json.error).toBe("Reactivate this person first.");
    // The audit log has the resend, and no password.
    const log = (await admin.api.get("/api/audit?event=USER_SIGNIN_RESENT")).json.items as { target: string }[];
    expect(log.some((i) => i.target.includes(p.name))).toBe(true);
    expect(JSON.stringify(log).toLowerCase().includes("password")).toBe(false);
  });

  // qa:TC missing
  test("AC4 (screen): the button on the person's page says what happened and shows no password", { annotation: { type: "qa:TC", description: "missing" } }, async ({ admin, later }) => {
    const p = await mk(admin, later, "resendui");
    await admin.page.goto(`/team/${p.id}`);
    await admin.page.getByRole("button", { name: "Resend sign-in details" }).click({ timeout: 60_000 });
    const note = admin.page.getByRole("status").filter({ hasText: /New sign-in details were emailed|did not send/ });
    await expect(note).toBeVisible({ timeout: 60_000 });
    const body = await admin.page.locator("body").innerText();
    expect(body.includes("Password:")).toBe(false);
  });

  // qa:TC missing
  test("AC5: wrong-password lockout and Forgot password are unchanged for a person who was added", { annotation: { type: "qa:TC", description: "missing" } }, async ({ anon, admin, later }) => {
    // Locking out an added person would lock a real account, so this uses the ZZ-TEST person: 5 wrong tries lock it, and the screen still offers Forgot password.
    const p = await mk(admin, later, "lockout");
    for (let i = 0; i < 5; i++) expect((await anon.request.post("/api/auth/signin", { data: { email: p.email, password: `wrong-pass-${i}9` } })).status()).toBe(401);
    const locked = await anon.request.post("/api/auth/signin", { data: { email: p.email, password: "wrong-pass-69" } });
    expect(locked.status()).toBe(429);
    expect((await locked.json()).error).toBe("Too many attempts. Try again in 15 minutes.");
    await anon.goto("/signin");
    await expect(anon.getByRole("link", { name: "Forgot password?" })).toBeVisible();
    // Resend sign-in details clears the lockout and gives a new password.
    expect((await admin.api.post(`/api/team/${p.id}/resend`)).status).toBe(200);
    const after = await anon.request.post("/api/auth/signin", { data: { email: p.email, password: "wrong-pass-79" } });
    expect(after.status(), "the lockout was cleared by the resend").toBe(401);
  });
});
