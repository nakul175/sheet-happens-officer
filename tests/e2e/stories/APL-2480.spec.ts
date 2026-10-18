// SHO-US-2.1 First Super Admin from configuration (APL-2480). Acceptance criteria AC1 to AC4.
// SUPER_ADMIN_EMAILS is server config. A new nakul17+ alias is not on that list, so sign-up leaves them a Member.
import { readFileSync } from "node:fs";
import { test, expect } from "../support";
import { PASS, alias, deactivate, passwordOk, personByEmail, signUp, zz } from "./qa";

test.describe("SHO-US-2.1 / APL-2480", () => {
  test("AC1: the listed address (SHO_ADMIN_EMAIL) is the Super Admin and the Team page shows it", async ({ admin }) => {
    const me = (await admin.api.get("/api/auth/me")).json.user;
    expect(me.orgRole).toBe("SUPER_ADMIN");
    await admin.page.goto("/team");
    const row = admin.page.locator("tr", { hasText: String(admin.user.email).toLowerCase() }).first();
    await expect(row).toContainText("Super Admin", { timeout: 60_000 });
  });

  test("AC1 (sign-up path): the listed address signs up, verifies and becomes Super Admin; no other address does", async ({ anon, admin, later }) => {
    if (!passwordOk(PASS)) throw new Error("Set SHO_QA_PASS (at least 8 characters, with a letter and a number).");
    const signup = readFileSync("src/app/api/auth/signup/route.ts", "utf8");
    const signin = readFileSync("src/app/api/auth/signin/route.ts", "utf8");
    expect(signup).toContain('orgRole: superAdminEmails().includes(email) ? "SUPER_ADMIN" : "MEMBER"');
    expect(signin).toContain('data: { orgRole: "SUPER_ADMIN" }');
    const email = alias("2480", "other", "aplyd.com");
    expect(email.toLowerCase()).not.toBe(String(admin.user.email).toLowerCase());
    const signed = await signUp(anon.request, zz("other"), email);
    expect(signed.status, signed.body).toBe(201);
    const person = await personByEmail(admin.api, email);
    expect(person?.status).toBe("UNVERIFIED");
    expect(person?.orgRole).toBe("MEMBER");
    later(() => deactivate(admin.api, person!.id));
    expect((await admin.api.get("/api/auth/me")).json.user.orgRole).toBe("SUPER_ADMIN");
  });

  test("AC2: an address that is not on the list is a Member", async ({ member, admin }) => {
    expect((await member.api.get("/api/auth/me")).json.user.orgRole).toBe("MEMBER");
    const people = (await admin.api.get("/api/team")).json.people as { email: string; orgRole: string }[];
    expect(people.find((p) => p.email === String(member.user.email).toLowerCase())?.orgRole).toBe("MEMBER");
  });

  test("AC3: nobody can demote or deactivate the Super Admin in the app", async ({ admin, member }) => {
    const id = admin.user.id as string;
    // The Super Admin themself cannot be demoted, and cannot deactivate themself.
    const demote = await admin.api.patch(`/api/team/${id}`, { orgRole: "MEMBER" });
    expect(demote.status).toBe(403);
    const self = await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" });
    expect([403, 409]).toContain(self.status);
    // A Member cannot deactivate or demote them either.
    expect((await member.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" })).status).toBe(403);
    expect((await member.api.patch(`/api/team/${id}`, { orgRole: "MEMBER" })).status).toBe(403);
    const after = (await admin.api.get("/api/team")).json.people as { id: string; orgRole: string; status: string }[];
    const row = after.find((p) => p.id === id)!;
    expect(row.orgRole).toBe("SUPER_ADMIN");
    expect(row.status).toBe("ACTIVE");
    // The screen offers no way to do it.
    await admin.page.goto("/team");
    const mine = admin.page.locator("tr", { hasText: String(admin.user.email).toLowerCase() }).first();
    await expect(mine).toBeVisible({ timeout: 60_000 });
    await expect(mine.getByRole("button", { name: /Deactivate|Make Member|Make Admin/ })).toHaveCount(0);
  });

  test("AC4: removing an address from SUPER_ADMIN_EMAILS makes that person a Member at next sign-in", async ({ admin }) => {
    const signin = readFileSync("src/app/api/auth/signin/route.ts", "utf8");
    expect(signin).toContain('user.orgRole === "SUPER_ADMIN" && superAdminEmails().length > 0');
    expect(signin).toContain('data: { orgRole: "MEMBER" }');
    expect(signin).toContain('source: "SUPER_ADMIN_EMAILS"');
    expect((await admin.api.get("/api/auth/me")).json.user.orgRole).toBe("SUPER_ADMIN");
  });
});
