// SHO-US-23.3 New person gets sign-in details by email (APL-2622). Acceptance criteria AC1 to AC5.
// The emailed password is only ever in the person's inbox, so what the email says and what the person sees at first sign-in are manual.
// Resend sign-in details is exercised on throw-away "ZZ-TEST" people at an .invalid address.
import { readFileSync } from "node:fs";
import { test, expect, RUN, type Json } from "../support";
import { alias, BASE_URL, sinkText } from "./qa";
import { signInDetailsMail } from "../../../src/lib/email";

const mk = async (admin: { api: { post: (p: string, b?: unknown) => Promise<{ status: number; json: Json }>; get: (p: string) => Promise<{ status: number; json: Json }> } }, later: (f: () => Promise<unknown>) => void, label: string) => {
  const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `${label} ${RUN}`, email: `zz-test-${RUN}-${label}@example.invalid`, role: "MEMBER" });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.person.id as string;
  later(async () => { if ((await admin.api.get(`/api/team/${id}`)).json.person?.status !== "DEACTIVATED") await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }); });
  return { id, name: `ZZ-TEST ${label} ${RUN}`, email: `zz-test-${RUN}-${label}@example.invalid` };
};

test.describe("SHO-US-23.3 / APL-2622", () => {
  test("AC1: the email shows the sign-in link, the username and the password", async ({ admin, later }) => {
    const email = alias("2622", "ac1");
    const built = signInDetailsMail(email, "ZZ-TEST", "A Super Admin", "secret-pass-1");
    expect(built.text).toContain("/signin");
    expect(built.text).toContain(`Username: ${email}`);
    expect(built.text).toContain("Password: secret-pass-1");
    const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `mail ${RUN}`, email, role: "MEMBER" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    later(async () => { await admin.api.post(`/api/team/${r.json.person.id}/deactivate`, { reassign: "leaders" }); });
    expect(JSON.stringify(r.json).toLowerCase().includes("password")).toBe(false);
    expect(readFileSync("src/lib/team.ts", "utf8")).toContain("signInDetailsMail");
    const text = await sinkText(email, "Your Sheet Happens Officer account");
    if (!text) return;
    expect(text).toContain("/signin");
    expect(text).toContain(`Username: ${email}`);
    expect(text).toMatch(/^Password: .+$/m);
  });

  test("AC2 (APL-2624): the temporary password signs in and must be replaced", async ({ admin, browser, later }) => {
    const email = alias("2622", "ac2");
    const copy = signInDetailsMail(email, "ZZ-TEST", "A Super Admin", "secret-pass-1").text;
    expect(copy).toMatch(/temporary.*sign in.*set your own password/s);
    expect(copy).not.toContain("stays valid");
    const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `keep ${RUN}`, email, role: "MEMBER" });
    expect(r.status).toBe(201);
    later(async () => { await admin.api.post(`/api/team/${r.json.person.id}/deactivate`, { reassign: "leaders" }); });
    const text = await sinkText(email, "Your Sheet Happens Officer account");
    if (!text) return;
    const password = text.match(/^Password: (.+)$/m)?.[1];
    expect(password).toBeTruthy();
    const ctx = await browser.newContext({
      baseURL: BASE_URL,
      httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    });
    const signed = await ctx.request.post("/api/auth/signin", { data: { email, password } });
    expect(signed.ok()).toBe(true);
    await ctx.close();
  });

  test("AC3 (superseded by APL-2624): first sign-in shows the mandatory password screen", async ({ admin, browser, later }) => {
    const email = alias("2622", "ac3");
    const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `bar ${RUN}`, email, role: "MEMBER" });
    expect(r.status).toBe(201);
    later(async () => { await admin.api.post(`/api/team/${r.json.person.id}/deactivate`, { reassign: "leaders" }); });
    const text = await sinkText(email, "Your Sheet Happens Officer account");
    if (!text) return;
    const password = text.match(/^Password: (.+)$/m)?.[1];
    expect(password).toBeTruthy();
    const ctx = await browser.newContext({
      baseURL: BASE_URL,
      httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    });
    const page = await ctx.newPage();
    await page.goto("/signin");
    await page.getByLabel("Work email").fill(email);
    await page.getByLabel("Password").fill(password!);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Set your own password" })).toBeVisible();
    await expect(page.getByLabel("New password", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Close this message" })).toHaveCount(0);
    await ctx.close();
  });

  test("AC4: Resend sign-in details answers with an emailed/not-emailed flag only, never a password, and is for the Super Admin only", async ({ admin, member, later }) => {
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

  test("AC4 (screen): the button on the person's page says what happened and shows no password", async ({ admin, later }) => {
    const p = await mk(admin, later, "resendui");
    await admin.page.goto(`/team/${p.id}`);
    await admin.page.getByRole("button", { name: "Resend sign-in details" }).click({ timeout: 60_000 });
    const note = admin.page.getByRole("status").filter({ hasText: /New sign-in details were emailed|did not send/ });
    await expect(note).toBeVisible({ timeout: 60_000 });
    const body = await admin.page.locator("body").innerText();
    expect(body.includes("Password:")).toBe(false);
  });

  test("AC5: wrong-password lockout and Forgot password are unchanged for a person who was added", async ({ anon, admin, later }) => {
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
