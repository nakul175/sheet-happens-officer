// SHO-US-2.5 Team page by role (APL-2484). Acceptance criteria AC1 to AC4.
import { test, expect, RUN, type Json } from "../support";
import { PASS, alias, deactivate, passwordOk, personByEmail, signUp, zz } from "./qa";

const SLOW = { timeout: 90_000 }; // the Team table can be long on a busy workspace

test.describe("SHO-US-2.5 / APL-2484", () => {
  test("AC1: a Member sees active people's names only, with no email, status or management action", async ({ member }) => {
    await member.page.goto("/team");
    await expect(member.page.getByRole("heading", { name: "Team" }).first()).toBeVisible(SLOW);
    await expect(member.page.locator(".list .item").first()).toBeVisible(SLOW);
    await expect(member.page.getByRole("columnheader", { name: /Email|Status/ })).toHaveCount(0);
    await expect(member.page.getByRole("button", { name: /Deactivate|Reactivate|Make Admin|Make Member|Resend sign-in details|Add person/ })).toHaveCount(0);
    await expect(member.page.getByText(/@/).first()).toHaveCount(0); // no email address anywhere in the list
    const people = (await member.api.get("/api/team")).json.people as Json[];
    expect(people.length).toBeGreaterThan(0);
    for (const p of people) {
      expect(p, "a Member's row").not.toHaveProperty("email");
      expect(p).not.toHaveProperty("status");
    }
  });

  test("AC2: an Admin or Super Admin also sees email, role and status columns and the actions their role allows", async ({ admin }) => {
    test.setTimeout(240_000);
    await admin.page.goto("/team");
    for (const h of ["Name", "Email", "Role", "Status", "Actions"]) await expect(admin.page.getByRole("columnheader", { name: h, exact: true }).first()).toBeVisible(SLOW);
    await expect(admin.page.getByRole("button", { name: "+ Add person" })).toBeVisible(SLOW);
    await expect(admin.page.getByRole("button", { name: "Make Admin" }).first()).toBeVisible(SLOW);
    await expect(admin.page.getByRole("button", { name: "Deactivate" }).first()).toBeVisible(SLOW);
    const people = (await admin.api.get("/api/team")).json.people as Json[];
    expect(people.every((p) => "email" in p && "status" in p && "orgRole" in p)).toBe(true);
  });

  test("AC3: deactivated people show a grey Deactivated chip to Admins and are hidden from Members", async ({ admin, member, later }) => {
    test.setTimeout(240_000);
    const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `hidden ${RUN}`, email: `zz-test-${RUN}-hidden@example.invalid`, role: "MEMBER" });
    expect(r.status).toBe(201);
    const id = r.json.person.id as string;
    const name = `ZZ-TEST hidden ${RUN}`;
    later(async () => { if ((await admin.api.get(`/api/team/${id}`)).json.person?.status !== "DEACTIVATED") await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }); });
    expect((await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" })).status).toBe(200);

    await admin.page.goto("/team");
    const row = admin.page.locator("tr", { hasText: name });
    await expect(row).toContainText("Deactivated", SLOW);
    await expect(row.locator(".chip.grey", { hasText: "Deactivated" })).toBeVisible();

    const seen = (await member.api.get("/api/team")).json.people as Json[];
    expect(seen.some((p) => p.id === id), "a Member must not see a deactivated person").toBe(false);
    await member.page.goto("/team");
    await expect(member.page.locator(".list .item").first()).toBeVisible(SLOW);
    await expect(member.page.getByText(name)).toHaveCount(0);
  });

  test("AC3 (unverified): unverified people show an Unverified status to Admins and are hidden from Members", async ({ anon, admin, member, later }) => {
    test.setTimeout(180_000);
    if (!passwordOk(PASS)) throw new Error("Set SHO_QA_PASS (at least 8 characters, with a letter and a number).");
    const email = alias("2484", "unverified", "aplyd.com");
    const name = zz("unverified");
    const signed = await signUp(anon.request, name, email);
    expect(signed.status, signed.body).toBe(201);
    const person = await personByEmail(admin.api, email);
    expect(person?.status).toBe("UNVERIFIED");
    later(() => deactivate(admin.api, person!.id));
    await admin.page.goto("/team");
    const row = admin.page.locator("tr", { hasText: name });
    await expect(row).toContainText("Unverified", SLOW);
    const seen = (await member.api.get("/api/team")).json.people as { id?: string; name?: string }[];
    expect(seen.some((p) => p.id === person!.id || p.name === name)).toBe(false);
    await member.page.goto("/team");
    await expect(member.page.locator(".list .item").first()).toBeVisible(SLOW);
    await expect(member.page.getByText(name)).toHaveCount(0);
  });

  test("AC4: the Super Admin's own row has no management action", async ({ admin }) => {
    test.setTimeout(240_000);
    await admin.page.goto("/team");
    const mine = admin.page.locator("tr", { hasText: String(admin.user.email).toLowerCase() }).first();
    await expect(mine).toContainText("Super Admin", SLOW);
    await expect(mine.getByRole("button", { name: /Deactivate|Reactivate|Make Admin|Make Member|Resend sign-in details/ })).toHaveCount(0);
  });
});
