// SHO-US-2.5 Team page by role (APL-2484). Acceptance criteria AC1 to AC4.
import { test, expect, RUN, type Json } from "../support";
import {
  PASS, alias, deactivate, passwordOk, personByEmail, signUp, zz,
  addPersonOnTeam, deactivateOnTeam, expectTeamColumns, memberItem, teamRow, type Api,
} from "./qa";

const SLOW = { timeout: 90_000 }; // the Team table can be long on a busy workspace

test.describe("SHO-US-2.5 / APL-2484", () => {
  test.beforeAll(() => {
    if (!PASS) throw new Error("Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
    if (!passwordOk(PASS)) throw new Error("SHO_QA_PASS must be at least 8 characters with a letter and a number.");
  });

  const zzEmail = (label: string) => `zz-test-${RUN}-${label}@example.invalid`;

  async function retire(api: Api, email: string) {
    const person = await personByEmail(api, email);
    if (person && person.status !== "DEACTIVATED") await deactivate(api, person.id);
  }

  test("AC1: a Member sees active people's names only, with no email, status or management action (qa:TC missing)", async ({ admin, member, later }) => {
    test.setTimeout(240_000);
    const name = zz("ac1");
    const email = zzEmail("ac1");
    const space = name.indexOf(" ");
    later(() => retire(admin.api, email));
    await addPersonOnTeam(admin.page, name.slice(0, space), name.slice(space + 1), email);

    await member.page.goto("/team");
    const main = member.page.locator("#main");
    await expect(main.getByRole("heading", { name: "Team", exact: true })).toBeVisible(SLOW);
    const item = memberItem(member.page, name);
    await expect(item).toHaveCount(1, SLOW);
    await expect(item.getByRole("link", { name, exact: true })).toBeVisible();
    await expect(item.getByText(/@/)).toHaveCount(0);
    await expect(item.getByText(/Active|Unverified|Deactivated/)).toHaveCount(0);
    await expect(item.getByRole("button")).toHaveCount(0);
    await expect(main.getByRole("columnheader", { name: /Email|Status/ })).toHaveCount(0);
    await expect(main.getByRole("button", { name: /Deactivate|Reactivate|Make Admin|Make Member|Resend sign-in details|Add person/ })).toHaveCount(0);
    await expect(main.locator(".list").getByText(/@/)).toHaveCount(0);
    const people = (await member.api.get("/api/team")).json.people as Json[];
    const created = people.find((p) => p.name === name);
    expect(created, "the person just added").toBeTruthy();
    expect(created, "a Member's row").not.toHaveProperty("email");
    expect(created).not.toHaveProperty("status");
  });

  test("AC2: an Admin or Super Admin also sees email, role and status columns and the actions their role allows (qa:TC missing)", async ({ admin, later }) => {
    test.setTimeout(240_000);
    const name = zz("ac2");
    const email = zzEmail("ac2");
    const space = name.indexOf(" ");
    later(() => retire(admin.api, email));
    await addPersonOnTeam(admin.page, name.slice(0, space), name.slice(space + 1), email);

    await expect(admin.page.locator("#main").getByRole("button", { name: "+ Add person" })).toBeVisible();
    const row = teamRow(admin.page, email);
    await expect(row).toHaveCount(1, SLOW);
    await expectTeamColumns(admin.page, row, ["Name", "Email", "Role", "Status", "Actions"]);
    await expect(row).toContainText(email);
    await expect(row.locator(".chip", { hasText: "Member" })).toBeVisible();
    await expect(row.locator(".chip.green", { hasText: "Active" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Make Admin" })).toBeVisible();
    await expect(row.getByRole("button", { name: "Deactivate" })).toBeVisible();
    const person = await personByEmail(admin.api, email);
    expect(person?.email).toBe(email);
    expect(person?.status).toBe("ACTIVE");
    expect(person?.orgRole).toBe("MEMBER");
  });

  test("AC3: deactivated people show a grey Deactivated chip to Admins and are hidden from Members (qa:TC missing)", async ({ admin, member, later }) => {
    test.setTimeout(240_000);
    const name = zz("hidden");
    const email = zzEmail("hidden");
    const space = name.indexOf(" ");
    later(() => retire(admin.api, email));
    await addPersonOnTeam(admin.page, name.slice(0, space), name.slice(space + 1), email);
    const created = await personByEmail(admin.api, email);
    expect(created?.id).toBeTruthy();
    await deactivateOnTeam(admin.page, name);

    const row = teamRow(admin.page, email);
    await expect(row).toHaveCount(1);
    await expect(row.locator(".chip.grey", { hasText: "Deactivated" })).toBeVisible();

    const seen = (await member.api.get("/api/team")).json.people as Json[];
    expect(seen.some((p) => p.id === created!.id), "a Member must not see a deactivated person").toBe(false);
    await member.page.goto("/team");
    await expect(memberItem(member.page, String(member.user.name))).toHaveCount(1, SLOW);
    await expect(memberItem(member.page, name)).toHaveCount(0);
    await expect(member.page.locator("#main").getByText(name, { exact: true })).toHaveCount(0);
  });

  test("AC3 (unverified): unverified people show an Unverified status to Admins and are hidden from Members (qa:TC missing)", async ({ anon, admin, member, later }) => {
    test.setTimeout(180_000);
    const email = alias("2484", "unverified", "aplyd.com");
    const name = zz("unverified");
    const signed = await signUp(anon.request, name, email);
    expect(signed.status, signed.body).toBe(201);
    const person = await personByEmail(admin.api, email);
    expect(person?.status).toBe("UNVERIFIED");
    later(() => deactivate(admin.api, person!.id));
    await admin.page.goto("/team");
    const row = teamRow(admin.page, email);
    await expect(row).toHaveCount(1, SLOW);
    await expect(row.locator(".chip.gold", { hasText: "Unverified" })).toBeVisible();
    const seen = (await member.api.get("/api/team")).json.people as { id?: string; name?: string }[];
    expect(seen.some((p) => p.id === person!.id || p.name === name)).toBe(false);
    await member.page.goto("/team");
    await expect(memberItem(member.page, String(member.user.name))).toHaveCount(1, SLOW);
    await expect(memberItem(member.page, name)).toHaveCount(0);
    await expect(member.page.locator("#main").getByText(name, { exact: true })).toHaveCount(0);
  });

  test("AC4: the Super Admin's own row has no management action (qa:TC missing)", async ({ admin, later }) => {
    test.setTimeout(240_000);
    const name = zz("ac4");
    const email = zzEmail("ac4");
    const space = name.indexOf(" ");
    later(() => retire(admin.api, email));
    await addPersonOnTeam(admin.page, name.slice(0, space), name.slice(space + 1), email);
    const created = teamRow(admin.page, email);
    await expect(created).toHaveCount(1, SLOW);
    await expect(created.getByRole("button", { name: "Deactivate" })).toBeVisible();
    await expect(created.getByRole("button", { name: "Make Admin" })).toBeVisible();

    const mine = teamRow(admin.page, String(admin.user.email));
    await expect(mine).toHaveCount(1);
    await expect(mine.locator(".chip", { hasText: "Super Admin" })).toBeVisible();
    await expect(mine.getByRole("button", { name: /Deactivate|Reactivate|Make Admin|Make Member|Resend sign-in details/ })).toHaveCount(0);
  });
});
