// SHO-US-23.4 Click a name, open the full profile (APL-2623). Acceptance criteria AC1 to AC6.
import { test, expect, RUN, zz } from "../support";

const SLOW = { timeout: 90_000 };
const mk = async (admin: any, later: (f: () => Promise<unknown>) => void, label: string) => {
  const email = `zz-test-${RUN}-${label}@example.invalid`;
  const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `${label} ${RUN}`, email, role: "MEMBER" });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = r.json.person.id as string;
  later(async () => { if ((await admin.api.get(`/api/team/${id}`)).json.person?.status !== "DEACTIVATED") await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }); });
  return { id, email, name: `ZZ-TEST ${label} ${RUN}` };
};

test.describe("SHO-US-23.4 / APL-2623", () => {
  test("AC1: my own name at the bottom of the sidebar opens my profile", async ({ admin }) => {
    await admin.page.goto("/");
    const me = admin.page.locator("a.me").first();
    await expect(me).toContainText(admin.user.name as string, SLOW);
    await me.click();
    await expect(admin.page).toHaveURL(/\/profile$/);
    await expect(admin.page.getByRole("heading", { name: "Profile" }).first()).toBeVisible();
    await expect(admin.page.getByText(process.env.SHO_ADMIN_EMAIL!.toLowerCase()).first()).toBeVisible();
  });

  test("AC2: every name on the Team page is a link to that person's profile, for a Member and for an Admin", async ({ admin, member }) => {
    test.setTimeout(360_000);
    // Member list.
    await member.page.goto("/team");
    const items = member.page.locator(".list .item");
    await expect(items.first()).toBeVisible(SLOW);
    expect(await member.page.locator(".list .item .t b a[href^='/team/']").count()).toBe(await items.count());
    // Admin table.
    await admin.page.goto("/team");
    const rows = admin.page.locator("table.tbl tbody tr");
    await expect(rows.first()).toBeVisible(SLOW);
    expect(await admin.page.locator("table.tbl tbody td[data-label='Name'] a[href^='/team/']").count()).toBe(await rows.count());
    // And a click really opens the person.
    const first = admin.page.locator("table.tbl tbody td[data-label='Name'] a[href^='/team/']").first();
    const name = (await first.textContent())!.trim();
    await expect(async () => { // a very long table can swallow the first click while it redraws, so the click is repeated until the page moves
      if (!/\/team\/[^/]+$/.test(admin.page.url())) await first.click({ timeout: 20_000 });
      await expect(admin.page).toHaveURL(/\/team\/[^/]+$/, { timeout: 15_000 });
    }).toPass({ timeout: 120_000 });
    await expect(admin.page.getByRole("heading", { name }).first()).toBeVisible(SLOW);
  });

  test("AC3: a Member sees a person's name and the projects they share, and no email, role, status or date", async ({ admin, member }) => {
    const raw = (await member.api.get(`/api/team/${admin.user.id}`));
    expect(raw.status).toBe(200);
    expect(Object.keys(raw.json.person).sort()).toEqual(["id", "name", "projects"]);
    await member.page.goto(`/team/${admin.user.id}`);
    await expect(member.page.getByRole("heading", { name: "Projects you share" })).toBeVisible(SLOW);
    await expect(member.page.getByText(process.env.SHO_ADMIN_EMAIL!.toLowerCase())).toHaveCount(0);
    await expect(member.page.getByText(/Joined|open task/)).toHaveCount(0);
  });

  test("AC4: an Admin sees email, role, status, date joined, every project with the person's role, and the count of open tasks", async ({ admin, later }) => {
    const p = await mk(admin, later, "profile");
    const proj = await admin.api.post("/api/projects", { name: zz("23.4 ac4"), leaderId: admin.user.id });
    const pid = proj.json.project.id as string;
    later(() => admin.api.post(`/api/projects/${pid}/archive`));
    expect((await admin.api.post(`/api/projects/${pid}/members`, { userId: p.id, role: "EDITOR" })).status).toBe(201);
    expect((await admin.api.post(`/api/projects/${pid}/tasks`, { title: zz("23.4 task"), assigneeId: p.id })).status).toBe(201);

    const api = (await admin.api.get(`/api/team/${p.id}`)).json.person;
    expect(api).toMatchObject({ name: p.name, email: p.email, orgRole: "MEMBER", status: "ACTIVE", openTasks: 1 });
    expect(typeof api.joinedAt).toBe("string");
    expect(api.projects).toEqual([{ id: pid, name: zz("23.4 ac4"), role: "EDITOR", openTasks: 1 }]);

    await admin.page.goto(`/team/${p.id}`);
    await expect(admin.page.getByRole("heading", { name: p.name }).first()).toBeVisible(SLOW);
    await expect(admin.page.getByText(`${p.email} · Member`)).toBeVisible();
    await expect(admin.page.locator(".chip", { hasText: "Active" })).toBeVisible();
    await expect(admin.page.getByText(/Joined \d/)).toBeVisible();
    await expect(admin.page.getByText("1 open task")).toBeVisible();
    await expect(admin.page.getByRole("columnheader", { name: "Their role" })).toBeVisible();
    const row = admin.page.locator("tr", { hasText: zz("23.4 ac4") });
    await expect(row).toContainText("Member");
    await expect(row.getByRole("cell").last()).toHaveText("1");
  });

  test("AC5: the Super Admin can Make Admin or Member, Resend sign-in details and reach Deactivate from the person's page", async ({ admin, later }) => {
    const p = await mk(admin, later, "actions");
    await admin.page.goto(`/team/${p.id}`);
    await expect(admin.page.getByRole("link", { name: "Deactivate from the Team list" })).toBeVisible(SLOW);
    await admin.page.getByRole("button", { name: "Make Admin" }).click();
    await expect(admin.page.getByText(`${p.name} is now an Admin.`)).toBeVisible(SLOW);
    expect(((await admin.api.get(`/api/team/${p.id}`)).json.person.orgRole)).toBe("ADMIN");
    await admin.page.getByRole("button", { name: "Make Member" }).click();
    await expect(admin.page.getByText(`${p.name} is now a Member.`)).toBeVisible(SLOW);
    expect(((await admin.api.get(`/api/team/${p.id}`)).json.person.orgRole)).toBe("MEMBER");
    await admin.page.getByRole("button", { name: "Resend sign-in details" }).click();
    await expect(admin.page.getByRole("status").filter({ hasText: /New sign-in details were emailed|did not send/ })).toBeVisible(SLOW);
    await admin.page.getByRole("link", { name: "Deactivate from the Team list" }).click();
    await expect(admin.page).toHaveURL(/\/team$/);
    // Your own page has none of these controls.
    await admin.page.goto(`/team/${admin.user.id}`);
    await expect(admin.page.getByRole("heading", { name: admin.user.name as string }).first()).toBeVisible(SLOW);
    await expect(admin.page.getByRole("button", { name: /Make Admin|Make Member|Resend sign-in details/ })).toHaveCount(0);
  });

  test("AC6: a deactivated person shows a Deactivated chip to Admins, and a Member who opens it gets 'not found'", async ({ admin, member, later }) => {
    const p = await mk(admin, later, "gone");
    expect((await admin.api.post(`/api/team/${p.id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
    await admin.page.goto(`/team/${p.id}`);
    await expect(admin.page.locator(".chip", { hasText: "Deactivated" })).toBeVisible(SLOW);
    expect((await member.api.get(`/api/team/${p.id}`)).status).toBe(404);
    await member.page.goto(`/team/${p.id}`);
    await expect(member.page.getByText("This person was not found.")).toBeVisible(SLOW);
  });
});
