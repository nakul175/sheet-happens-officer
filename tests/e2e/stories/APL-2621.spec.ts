// SHO-US-23.2 Super Admin adds a person (APL-2621). Acceptance criteria AC1 to AC7.
// Added people get an address like zz-test-<run>-<label>@example.invalid, so no real inbox is mailed. They are deactivated at the end;
// a person record cannot be deleted from the app.
import { test, expect, RUN, BASE_URL } from "../support";

const SLOW = { timeout: 90_000 };
const email = (label: string) => `zz-test-${RUN}-${label}@example.invalid`;

test.describe("SHO-US-23.2 / APL-2621", () => {
  test("AC1: only the Super Admin sees + Add person, and the server refuses anyone else", async ({ admin, member }) => {
    await admin.page.goto("/team");
    await expect(admin.page.getByRole("button", { name: "+ Add person" })).toBeVisible(SLOW);
    await member.page.goto("/team");
    await expect(member.page.locator(".list .item").first()).toBeVisible(SLOW);
    await expect(member.page.getByRole("button", { name: /Add person/ })).toHaveCount(0);
    const r = await member.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `nope ${RUN}`, email: email("nope"), role: "MEMBER" });
    expect(r.status).toBe(403);
    const people = (await admin.api.get("/api/team")).json.people as { email: string }[];
    expect(people.some((p) => p.email === email("nope"))).toBe(false);
  });

  test("AC2: the form has First name, Last name, Email and Role (Member by default, Admin), and never offers Super Admin", async ({ admin }) => {
    test.setTimeout(240_000);
    await admin.page.goto("/team");
    await admin.page.getByRole("button", { name: "+ Add person" }).click({ timeout: 90_000 });
    const dialog = admin.page.getByRole("dialog", { name: "Add person" });
    await expect(dialog).toBeVisible(SLOW);
    for (const l of ["First name", "Last name", "Email"]) await expect(dialog.getByLabel(l)).toBeVisible();
    const role = dialog.getByLabel("Role");
    await expect(role).toHaveValue("MEMBER");
    expect(await role.locator("option").allTextContents()).toEqual(["Member", "Admin"]);
    await expect(dialog.getByRole("button", { name: "Add and email" })).toBeDisabled();
    // The server will not accept Super Admin either.
    const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `sup ${RUN}`, email: email("sup"), role: "SUPER_ADMIN" });
    expect(r.status).toBe(400);
  });

  test("AC3: an email that already exists is refused; for a deactivated person the message offers Reactivate", async ({ admin, later }) => {
    const body = { firstName: "ZZ-TEST", lastName: `dup ${RUN}`, email: email("dup"), role: "MEMBER" };
    const first = await admin.api.post("/api/team", body);
    expect(first.status).toBe(201);
    const id = first.json.person.id as string;
    later(async () => { if ((await admin.api.get(`/api/team/${id}`)).json.person?.status !== "DEACTIVATED") await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }); });
    const again = await admin.api.post("/api/team", body);
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("A person with this email already exists.");
    // Same address in other letter case is the same person.
    expect((await admin.api.post("/api/team", { ...body, email: body.email.toUpperCase() })).status).toBe(409);
    expect((await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" })).status).toBe(200);
    const gone = await admin.api.post("/api/team", body);
    expect(gone.status).toBe(409);
    expect(gone.json.error).toMatch(/deactivated/);
    expect(gone.json.error).toMatch(/Reactivate/);
  });

  test("AC4: saving through the form creates an Active person named 'First Last' and shows the result", async ({ admin, later }) => {
    test.setTimeout(240_000);
    const addr = email("form");
    later(async () => {
      const row = ((await admin.api.get("/api/team")).json.people as { id: string; email: string; status: string }[]).find((p) => p.email === addr);
      if (row && row.status !== "DEACTIVATED") await admin.api.post(`/api/team/${row.id}/deactivate`, { reassign: "leaders" });
    });
    await admin.page.goto("/team");
    await admin.page.getByRole("button", { name: "+ Add person" }).click({ timeout: 90_000 });
    const dialog = admin.page.getByRole("dialog", { name: "Add person" });
    await dialog.getByLabel("First name").fill("ZZ-TEST");
    await dialog.getByLabel("Last name").fill(`form ${RUN}`);
    await dialog.getByLabel("Email").fill(addr);
    await dialog.getByRole("button", { name: "Add and email" }).click();
    // Either banner is a valid outcome here: the mail provider may or may not take an .invalid address (see AC5).
    await expect(admin.page.getByRole("status").filter({ hasText: `ZZ-TEST form ${RUN} was added` })).toBeVisible({ timeout: 120_000 });
    const row = ((await admin.api.get("/api/team")).json.people as { email: string; name: string; status: string; orgRole: string }[]).find((p) => p.email === addr)!;
    expect(row.name).toBe(`ZZ-TEST form ${RUN}`);
    expect(row.status).toBe("ACTIVE"); // no verification step (decision D4)
    expect(row.orgRole).toBe("MEMBER");
  });

  test.skip("AC4 (password): the password is random and stored only as a hash", async () => {
    // A hash in the database cannot be seen from a browser. Covered by tests/people.test.ts.
  });

  test.skip("AC5: when the email cannot be sent the account still exists, the banner says so and offers Resend sign-in details", async () => {
    // Needs the mail provider to fail on demand; staging sends through the real one. Covered by tests/people.test.ts.
  });

  test("AC6: the audit log records who added whom and with which role, and never the password", async ({ admin, later }) => {
    const body = { firstName: "ZZ-TEST", lastName: `audit ${RUN}`, email: email("audit"), role: "ADMIN" };
    const r = await admin.api.post("/api/team", body);
    expect(r.status).toBe(201);
    const id = r.json.person.id as string;
    later(async () => { await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }); });
    expect(r.json.person.orgRole).toBe("ADMIN");
    expect(JSON.stringify(r.json), "the response must not carry a password").not.toMatch(/password/i);
    const log = (await admin.api.get("/api/audit?event=USER_ADDED_BY_ADMIN")).json.items as { who: string; email: string; event: string; target: string }[];
    const row = log.find((i) => i.target.includes(`ZZ-TEST audit ${RUN}`));
    expect(row, "an audit row for the new person").toBeTruthy();
    expect(row!.email).toBe((admin.user.email as string).toLowerCase());
    expect(JSON.stringify(row)).not.toMatch(/password/i);
  });

  test("AC7: any email domain works, because only self-signup is limited", async ({ admin, later }) => {
    const addr = `zz-test-${RUN}-any@zz-test-other-domain.invalid`;
    const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `any ${RUN}`, email: addr, role: "MEMBER" });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json.person.id as string;
    later(async () => { await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }); });
    // A different, never-added address on that domain cannot self-sign-up: the domain rule still applies there.
    // (The added address would be refused as a duplicate, which would not prove the domain rule.)
    const anon = await (await import("@playwright/test")).request.newContext({
      baseURL: BASE_URL,
      httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    });
    try {
      const s = await anon.post("/api/auth/signup", { data: { name: "ZZ-TEST Any", email: `zz-test-${RUN}-selfsignup@zz-test-other-domain.invalid`, password: `Zz${RUN}9x` } });
      expect(s.status()).toBe(400);
    } finally { await anon.dispose(); }
  });
});
