// SHO-US-2.1 First Super Admin from configuration (APL-2480). Acceptance criteria AC1 to AC4.
// SUPER_ADMIN_EMAILS is server config. A new nakul17+ alias is not on that list, so sign-up leaves them a Member.
import { readFileSync } from "node:fs";
import { test, expect } from "../support";
import { PASS, alias, deactivate, passwordOk, personByEmail, signUp, teamRow, zz } from "./qa";

test.describe("SHO-US-2.1 / APL-2480", () => {
  test.beforeAll(() => {
    test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
    if (!PASS) return;
    if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
  });

  test("AC1: the listed address (SHO_ADMIN_EMAIL) is the Super Admin and the Team page shows it", async ({ admin }) => {
    const me = (await admin.api.get("/api/auth/me")).json.user;
    expect(me.orgRole).toBe("SUPER_ADMIN");
    await admin.page.goto("/team");
    const row = teamRow(admin.page, String(admin.user.email));
    await expect(row).toHaveCount(1, { timeout: 60_000 });
    await expect(row).toContainText("Super Admin");
  });

  test("AC1 (sign-up path): the listed address is Super Admin, and an address that is not listed signs up as a Member", async ({ anon, admin, later }) => {
    const listed = String(process.env.SHO_ADMIN_EMAIL || admin.user.email);
    const listedPerson = await personByEmail(admin.api, listed);
    expect(listedPerson?.orgRole, "the listed address").toBe("SUPER_ADMIN");
    const email = alias("2480", "other", "aplyd.com");
    expect(email.toLowerCase()).not.toBe(listed.toLowerCase());
    const signed = await signUp(anon.request, zz("other"), email);
    expect(signed.status, signed.body).toBe(201);
    const person = await personByEmail(admin.api, email);
    expect(person?.status).toBe("UNVERIFIED");
    expect(person?.orgRole).toBe("MEMBER");
    later(() => deactivate(admin.api, person!.id));
    expect((await admin.api.get("/api/auth/me")).json.user.orgRole).toBe("SUPER_ADMIN");
  });

  // @static: source only. The staging workflow passes --grep-invert @static, so this stays out of that run.
  test("AC1 (source): sign-up and sign-in assign Super Admin only from the configured list", { tag: "@static" }, () => {
    const signup = readFileSync("src/app/api/auth/signup/route.ts", "utf8");
    const signin = readFileSync("src/app/api/auth/signin/route.ts", "utf8");
    expect(signup).toContain('orgRole: superAdminEmails().includes(email) ? "SUPER_ADMIN" : "MEMBER"');
    expect(signin).toContain('if (listed && user.orgRole !== "SUPER_ADMIN")');
    expect(signin).toContain('data: { role: "SUPER_ADMIN", source: "SUPER_ADMIN_EMAILS" }');
    expect(signin).toContain('user.orgRole = "SUPER_ADMIN"');
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
    const mine = teamRow(admin.page, String(admin.user.email));
    await expect(mine).toHaveCount(1, { timeout: 60_000 });
    await expect(mine.getByRole("button", { name: /Deactivate|Make Member|Make Admin/ })).toHaveCount(0);
  });

  // @static: staging cannot remove an address from SUPER_ADMIN_EMAILS. The same grep-invert keeps this out of that run.
  test("AC4: removing an address from SUPER_ADMIN_EMAILS makes that person a Member at next sign-in", { tag: "@static" }, () => {
    const signin = readFileSync("src/app/api/auth/signin/route.ts", "utf8");
    expect(signin).toContain('!listed && user.orgRole === "SUPER_ADMIN" && superAdminEmails().length > 0');
    expect(signin).toContain('data: { role: "MEMBER", source: "SUPER_ADMIN_EMAILS" }');
    expect(signin).toContain('user.orgRole = "MEMBER"');
  });
});
