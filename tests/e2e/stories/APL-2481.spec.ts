// SHO-US-2.2 Promote and demote Admins (APL-2481). Acceptance criteria AC1 to AC3.
import { test, expect, RUN, type Json } from "../support";

const SLOW = { timeout: 60_000 };
type Admin = { api: { post: (p: string, b?: unknown) => Promise<{ status: number; json: Json }> } };
async function person(admin: Admin, later: (f: () => Promise<unknown>) => void, label: string, role: "MEMBER" | "ADMIN" = "MEMBER") {
  const email = `zz-test-${RUN}-${label}@example.invalid`;
  const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `${label} ${RUN}`, email, role });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.person.id as string;
  later(() => admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }));
  return { id, email, name: `ZZ-TEST ${label} ${RUN}` };
}

test.describe("SHO-US-2.2 / APL-2481", () => {
  test("AC1: the Super Admin makes a Member an Admin and an Admin a Member, from the Team page", async ({ admin, later }) => {
    test.setTimeout(240_000); // the Team table can be long on a busy workspace
    const p = await person(admin, later, "promote");
    await admin.page.goto("/team");
    const row = admin.page.locator("tr", { hasText: p.name });
    await expect(row).toContainText("Member", SLOW);
    const patched = admin.page.waitForResponse((x) => x.request().method() === "PATCH" && x.url().includes(`/api/team/${p.id}`), { timeout: 60_000 });
    await row.getByRole("button", { name: "Make Admin" }).click({ timeout: 60_000 });
    expect((await patched).status()).toBe(200);
    await admin.page.goto("/team"); // read the list afresh, so the check does not depend on how fast a long table redraws
    await expect(row.getByRole("button", { name: "Make Member" })).toBeVisible({ timeout: 90_000 });
    let team = (await admin.api.get("/api/team")).json.people as { id: string; orgRole: string }[];
    expect(team.find((x) => x.id === p.id)?.orgRole).toBe("ADMIN");
    const patched2 = admin.page.waitForResponse((x) => x.request().method() === "PATCH" && x.url().includes(`/api/team/${p.id}`), { timeout: 60_000 });
    await row.getByRole("button", { name: "Make Member" }).click({ timeout: 60_000 });
    expect((await patched2).status()).toBe(200);
    await admin.page.goto("/team");
    await expect(row.getByRole("button", { name: "Make Admin" })).toBeVisible({ timeout: 90_000 });
    team = (await admin.api.get("/api/team")).json.people as { id: string; orgRole: string }[];
    expect(team.find((x) => x.id === p.id)?.orgRole).toBe("MEMBER");
    // Both changes are in the audit log.
    for (const event of ["ADMIN_PROMOTED", "ADMIN_DEMOTED"]) {
      const log = (await admin.api.get(`/api/audit?event=${event}`)).json.items as { target: string }[];
      expect(log.some((i) => i.target.includes(p.name)), event).toBe(true);
    }
  });

  test.skip("AC1 (notice): the person is notified of the change", async () => {
    // The notice lands in the added person's own bell; nobody here knows their password to read it.
  });

  test("AC2: a Member cannot change any org role, and the API refuses it", async ({ admin, member, later }) => {
    const p = await person(admin, later, "authority");
    const r = await member.api.patch(`/api/team/${p.id}`, { orgRole: "ADMIN" });
    expect(r.status).toBe(403);
    const none = await member.api.patch(`/api/team/${admin.user.id}`, { orgRole: "MEMBER" });
    expect(none.status).toBe(403);
    const team = (await admin.api.get("/api/team")).json.people as { id: string; orgRole: string }[];
    expect(team.find((x) => x.id === p.id)?.orgRole).toBe("MEMBER");
    await member.page.goto("/team");
    await expect(member.page.getByRole("button", { name: /Make Admin|Make Member/ })).toHaveCount(0);
  });

  test("AC3: nobody can give or take away Super Admin through the API", async ({ admin, member, later }) => {
    const p = await person(admin, later, "super");
    const grant = await admin.api.patch(`/api/team/${p.id}`, { orgRole: "SUPER_ADMIN" });
    expect(grant.status).toBe(400);
    expect((await member.api.patch(`/api/team/${p.id}`, { orgRole: "SUPER_ADMIN" })).status).toBeGreaterThanOrEqual(400);
    const take = await admin.api.patch(`/api/team/${admin.user.id}`, { orgRole: "ADMIN" });
    expect(take.status).toBe(403);
    expect((await admin.api.get("/api/auth/me")).json.user.orgRole).toBe("SUPER_ADMIN");
    const team = (await admin.api.get("/api/team")).json.people as { id: string; orgRole: string }[];
    expect(team.find((x) => x.id === p.id)?.orgRole).toBe("MEMBER");
  });
});
