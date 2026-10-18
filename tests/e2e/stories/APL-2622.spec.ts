// SHO-US-23.3 New person gets sign-in details by email (APL-2622). Acceptance criteria AC1 to AC5.
// The emailed password is only ever in the person's inbox, so what the email says and what the person sees at first sign-in are manual.
// Resend sign-in details is exercised on throw-away "ZZ-TEST" people at an .invalid address.
import { test, expect, RUN } from "../support";

const mk = async (admin: { api: { post: (p: string, b?: unknown) => Promise<{ status: number; json: any }>; get: (p: string) => Promise<{ status: number; json: any }> } }, later: (f: () => Promise<unknown>) => void, label: string) => {
  const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `${label} ${RUN}`, email: `zz-test-${RUN}-${label}@example.invalid`, role: "MEMBER" });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.person.id as string;
  later(async () => { if ((await admin.api.get(`/api/team/${id}`)).json.person?.status !== "DEACTIVATED") await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }); });
  return { id, name: `ZZ-TEST ${label} ${RUN}`, email: `zz-test-${RUN}-${label}@example.invalid` };
};

test.describe("SHO-US-23.3 / APL-2622", () => {
  test.skip("AC1: the email shows the sign-in link, the username and the password", async () => {
    // Needs a real mailbox to read the email. Covered by tests/people.test.ts against the local outbox.
  });

  test.skip("AC2: the password stays valid until the person changes it", async () => {
    // Needs the emailed password. (SHO-US-23.5 will replace this rule with a forced change at first sign-in.)
  });

  test.skip("AC3: the first sign-in shows a closable 'Set your own password' banner linking to Profile", async () => {
    // Needs the emailed password to sign in as the new person.
  });

  test("AC4: Resend sign-in details answers with an emailed/not-emailed flag only, never a password, and is for the Super Admin only", async ({ admin, member, later }) => {
    const p = await mk(admin, later, "resend");
    const r = await admin.api.post(`/api/team/${p.id}/resend`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(Object.keys(r.json)).toEqual(["emailSent"]);
    expect(typeof r.json.emailSent).toBe("boolean");
    expect(JSON.stringify(r.json)).not.toMatch(/password/i);
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
    expect(JSON.stringify(log)).not.toMatch(/password/i);
  });

  test("AC4 (screen): the button on the person's page says what happened and shows no password", async ({ admin, later }) => {
    const p = await mk(admin, later, "resendui");
    await admin.page.goto(`/team/${p.id}`);
    await admin.page.getByRole("button", { name: "Resend sign-in details" }).click({ timeout: 60_000 });
    const note = admin.page.getByRole("status").filter({ hasText: /New sign-in details were emailed|did not send/ });
    await expect(note).toBeVisible({ timeout: 60_000 });
    await expect(admin.page.locator("body")).not.toContainText(/Password:/);
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
