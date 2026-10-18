// SHO-US-2.1 First Super Admin from configuration (APL-2480). Acceptance criteria AC1 to AC4.
// Changing SUPER_ADMIN_EMAILS needs a server restart, and signing up the listed address sends a real email, so AC1's sign-up path and AC4 are manual.
import { test, expect } from "../support";

test.describe("SHO-US-2.1 / APL-2480", () => {
  test("AC1: the listed address (SHO_ADMIN_EMAIL) is the Super Admin and the Team page shows it", async ({ admin }) => {
    const me = (await admin.api.get("/api/auth/me")).json.user;
    expect(me.orgRole).toBe("SUPER_ADMIN");
    await admin.page.goto("/team");
    const row = admin.page.locator("tr", { hasText: process.env.SHO_ADMIN_EMAIL!.toLowerCase() }).first();
    await expect(row).toContainText("Super Admin", { timeout: 60_000 });
  });

  test.skip("AC1 (sign-up path): the listed address signs up, verifies and becomes Super Admin; no other address does", async () => {
    // Needs a fresh listed address and its mailbox for the verification link.
  });

  test("AC2: an address that is not on the list is a Member", async ({ member, admin }) => {
    expect((await member.api.get("/api/auth/me")).json.user.orgRole).toBe("MEMBER");
    const people = (await admin.api.get("/api/team")).json.people as { email: string; orgRole: string }[];
    expect(people.find((p) => p.email === process.env.SHO_MEMBER_EMAIL!.toLowerCase())?.orgRole).toBe("MEMBER");
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
    const mine = admin.page.locator("tr", { hasText: process.env.SHO_ADMIN_EMAIL!.toLowerCase() }).first();
    await expect(mine).toBeVisible({ timeout: 60_000 });
    await expect(mine.getByRole("button", { name: /Deactivate|Make Member|Make Admin/ })).toHaveCount(0);
  });

  test.skip("AC4: removing an address from SUPER_ADMIN_EMAILS makes that person a Member at next sign-in", async () => {
    // Needs the server setting changed and the app restarted. Server config, not reachable from a browser test.
  });
});
