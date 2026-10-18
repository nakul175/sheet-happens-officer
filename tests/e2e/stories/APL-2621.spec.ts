// SHO-US-23.2 Super Admin adds a person (APL-2621). Acceptance criteria AC1 to AC7.
// Added people get an address like zz-test-<run>-<label>@example.invalid, so no real inbox is mailed. They are deactivated at the end;
// a person record cannot be deleted from the app.
// AC4 reads the generated password from the test mail sink and, on a local run, the hash from the database.
// AC5 blocks the local outbox so the send fails; the account must still exist and the banner must say so.
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, RUN, BASE_URL, login } from "../support";
import { mailedPassword, localPasswordHash, waitForSinkMail, PASS, passwordOk } from "./qa";

const SLOW = { timeout: 90_000 };
const email = (label: string) => `zz-test-${RUN}-${label}@example.invalid`;

/** On a local server, put a file where the outbox directory is so sendMail throws. Staging is left alone. */
async function blockLocalOutbox(): Promise<() => void> {
  const host = new URL(BASE_URL).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") return () => {};
  const dir = process.env.EMAIL_OUTBOX_DIR ?? path.join(process.cwd(), ".outbox");
  const held = `${dir}.held-${Date.now()}`;
  const had = existsSync(dir);
  if (had) renameSync(dir, held);
  writeFileSync(dir, "blocked");
  return () => {
    rmSync(dir, { force: true });
    if (had) renameSync(held, dir);
  };
}

test.describe("SHO-US-23.2 / APL-2621", () => {
  test.beforeAll(() => {
    test.skip(!PASS, "Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
    test.skip(!passwordOk(PASS), "SHO_QA_PASS must be at least 8 characters with a letter and a number.");
    try { login("ADMIN"); } catch { test.skip(true, "Set SHO_ADMIN_EMAIL and SHO_ADMIN_PASS (a Super Admin)."); }
  });

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

  test("AC4 (password): the password is random and stored only as a hash", async ({ admin, later }) => {
    const make = async (label: string) => {
      const addr = email(label);
      const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: `${label} ${RUN}`, email: addr, role: "MEMBER" });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      later(async () => { await admin.api.post(`/api/team/${r.json.person.id}/deactivate`, { reassign: "leaders" }); });
      return { addr, body: JSON.stringify(r.json) };
    };
    const a = await make("pw-a");
    const b = await make("pw-b");
    const first = (await waitForSinkMail(a.addr, "Your Sheet Happens Officer account")).text ?? "";
    const second = mailedPassword(b.addr) ?? (await waitForSinkMail(b.addr, "Your Sheet Happens Officer account")).text?.match(/^Password: (.+)$/m)?.[1] ?? "";
    const passA = first.match(/^Password: (.+)$/m)?.[1] ?? "";
    expect(passA).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(/[A-Za-z]/.test(passA) && /[0-9]/.test(passA)).toBe(true);
    expect(second).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(passA).not.toBe(second);
    expect(a.body.includes(passA)).toBe(false);
    expect(b.body.toLowerCase().includes("password")).toBe(false);
    const log = JSON.stringify((await admin.api.get("/api/audit?event=USER_ADDED_BY_ADMIN")).json);
    expect(log.includes(passA)).toBe(false);
    expect(log.includes(second)).toBe(false);
    const signed = await (await import("@playwright/test")).request.newContext({ baseURL: BASE_URL });
    try {
      const r = await signed.post("/api/auth/signin", { data: { email: a.addr, password: passA } });
      expect(r.status(), "the emailed password works, so a verifier was stored").toBe(200);
      expect((await r.text()).includes(passA)).toBe(false);
    } finally { await signed.dispose(); }
    const hash = await localPasswordHash(a.addr);
    if (hash !== null) {
      expect(hash.startsWith("scrypt$"), "stored only as a scrypt hash").toBe(true);
      expect(hash.includes(passA)).toBe(false);
    }
  });

  test("AC5: when the email cannot be sent the account still exists, the banner says so and offers Resend sign-in details", async ({ admin, later }) => {
    test.setTimeout(240_000);
    const addr = email("nosend");
    const name = `ZZ-TEST nosend ${RUN}`;
    later(async () => {
      const row = ((await admin.api.get("/api/team")).json.people as { id: string; email: string; status: string }[]).find((p) => p.email === addr);
      if (row && row.status !== "DEACTIVATED") await admin.api.post(`/api/team/${row.id}/deactivate`, { reassign: "leaders" });
    });
    await admin.page.goto("/team");
    await admin.page.getByRole("button", { name: "+ Add person" }).click({ timeout: 90_000 });
    const dialog = admin.page.getByRole("dialog", { name: "Add person" });
    await dialog.getByLabel("First name").fill("ZZ-TEST");
    await dialog.getByLabel("Last name").fill(`nosend ${RUN}`);
    await dialog.getByLabel("Email").fill(addr);
    const posted = admin.page.waitForResponse((r) => new URL(r.url()).pathname === "/api/team" && r.request().method() === "POST");
    const restore = await blockLocalOutbox();
    let res;
    try {
      await dialog.getByRole("button", { name: "Add and email" }).click();
      res = await posted;
    } finally { restore(); }
    expect(res!.status(), "add person").toBe(201);
    const sent = ((await res!.json()) as { person?: { emailSent?: boolean } }).person?.emailSent;
    expect(sent, "the send was made to fail so the banner can be checked").toBe(false);
    const people = (await admin.api.get("/api/team")).json.people as { email: string; name: string; status: string }[];
    const row = people.find((p) => p.email === addr);
    expect(row?.name).toBe(name);
    expect(row?.status).toBe("ACTIVE");
    const banner = admin.page.getByRole("status").filter({ hasText: "did not send" });
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText("Resend sign-in details");
    const shown = await banner.innerText();
    expect(shown.includes("Password:")).toBe(false);
    await expect(admin.page.locator("tbody tr", { hasText: addr }).getByRole("button", { name: "Resend sign-in details" })).toBeVisible();
  });

  test("AC6: the audit log records who added whom and with which role, and never the password", async ({ admin, later }) => {
    const body = { firstName: "ZZ-TEST", lastName: `audit ${RUN}`, email: email("audit"), role: "ADMIN" };
    const r = await admin.api.post("/api/team", body);
    expect(r.status).toBe(201);
    const id = r.json.person.id as string;
    later(async () => { await admin.api.post(`/api/team/${id}/deactivate`, { reassign: "leaders" }); });
    expect(r.json.person.orgRole).toBe("ADMIN");
    const added = JSON.stringify(r.json);
    expect(added.toLowerCase().includes("password"), "the response must not carry a password").toBe(false);
    const log = (await admin.api.get("/api/audit?event=USER_ADDED_BY_ADMIN")).json.items as { who: string; email: string; event: string; target: string }[];
    const row = log.find((i) => i.target.includes(`ZZ-TEST audit ${RUN}`));
    expect(row, "an audit row for the new person").toBeTruthy();
    expect(row!.email).toBe((admin.user.email as string).toLowerCase());
    expect(JSON.stringify(row).toLowerCase().includes("password")).toBe(false);
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
