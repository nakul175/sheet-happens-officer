// APL-2733. A bad password shows the password message once.
// Sign-up, reset-password and change-password. Desktop and 390x844.
// ZZ-TEST names, nakul17+ aliases. workers=1 (playwright.config.ts).
// A valid password is not sent to the server. The change-password page needs one
// signed-in ZZ-TEST person; afterAll removes only that row. Bad passwords stop
// at validation, so the stored password is not replaced.
import { createHash, randomBytes, scrypt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { test, expect, type Page, type Response } from "@playwright/test";
import pg from "pg";

const scryptAsync = promisify(scrypt);

const PASSWORD_MESSAGE = "Use at least 8 characters, with at least one letter and one number.";
const VALID_PASSWORD = "goodpass7";
const FAKE_RESET_TOKEN = "zz-test-reset-token-0123456789";
const EVIDENCE = process.env.APL_2733_EVIDENCE ?? "/opt/cursor/artifacts/apl-2733";

const SIZES = [
  { label: "desktop", width: 1280, height: 800 },
  { label: "390x844", width: 390, height: 844 },
] as const;

const FAILURES = [
  { key: "short", label: "short password", password: "short1" },
  { key: "long", label: "long password", password: `${"a".repeat(128)}1` },
  { key: "no-digit", label: "no digit", password: "abcdefgh" },
  { key: "no-letter", label: "no letter", password: "12345678" },
] as const;

const watched = new Set<string>();
let seq = 0;
const evidenceIndex: { slug: string; body: unknown }[] = [];

const CHANGE_EMAIL = `nakul17+zz2733-change-${Date.now().toString(36)}@aplyd.com`;
let changeSession = "";

/** The route announcer is also role=alert. It is not the form error. */
const errorAlert = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

test.beforeAll(async () => {
  if (!process.env.BASE_URL && !process.env.TASKBOARD_URL) {
    test.skip(true, "APL-2733 needs BASE_URL or TASKBOARD_URL");
    return;
  }
  changeSession = await createChangeUser();
});

test.afterAll(async () => {
  for (const email of watched) await deleteOnlyThisUser(email);
});

function person(label: string) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "case";
  const email = `nakul17+zz2733-${slug}-${(seq++).toString(36)}-${Date.now().toString(36)}@aplyd.com`;
  watched.add(email);
  return { name: `ZZ-TEST ${label}`, email };
}

/** Elements whose own text is the password message. Ancestors that only wrap it are not counted. */
async function passwordMessageCount(page: Page): Promise<number> {
  return page.evaluate((message) => {
    return Array.from(document.querySelectorAll("body *")).filter((el) =>
      Array.from(el.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() === message),
    ).length;
  }, PASSWORD_MESSAGE);
}

function appOrigin() {
  return (process.env.BASE_URL || process.env.TASKBOARD_URL || "http://localhost:3100").replace(/\/+$/, "");
}

async function openSignUp(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
}

async function fillSignUp(page: Page, name: string, email: string, password: string) {
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
}

async function openReset(page: Page, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.goto(`/reset?token=${encodeURIComponent(FAKE_RESET_TOKEN)}`);
  await expect(page.getByRole("heading", { name: "Set a new password" })).toBeVisible();
}

async function fillReset(page: Page, password: string) {
  await page.getByRole("textbox", { name: "New password", exact: true }).fill(password);
  await page.getByLabel("Confirm new password", { exact: true }).fill(password);
}

async function openChange(page: Page, size: { width: number; height: number }) {
  await page.context().addCookies([
    { name: "sho_session", value: changeSession, url: appOrigin(), httpOnly: true, sameSite: "Lax" },
  ]);
  await page.setViewportSize(size);
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Change password" })).toBeVisible();
}

async function fillChange(page: Page, password: string) {
  await page.getByLabel("Current password", { exact: true }).fill("not-the-password");
  await page.getByRole("textbox", { name: "New password", exact: true }).fill(password);
  await page.getByLabel("Confirm new password", { exact: true }).fill(password);
}

/** Writes the response body and a screenshot for this failure row. */
async function saveEvidence(page: Page, response: Response, slug: string) {
  const body: unknown = await response.json();
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(path.join(EVIDENCE, `${slug}.json`), `${JSON.stringify(body, null, 2)}\n`);
  const png = path.join(EVIDENCE, `${slug}.png`);
  await page.screenshot({ path: png, fullPage: true });
  evidenceIndex.push({ slug, body });
  writeFileSync(path.join(EVIDENCE, "index.json"), `${JSON.stringify(evidenceIndex, null, 2)}\n`);
  await test.info().attach(`${slug}.json`, { body: JSON.stringify(body, null, 2), contentType: "application/json" });
  await test.info().attach(`${slug}.png`, { path: png, contentType: "image/png" });
  expect(body, slug).toEqual({
    error: "Validation failed",
    issues: [{ path: ["password"], message: PASSWORD_MESSAGE }],
  });
}

function localDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname;
    if (host !== "localhost" && host !== "127.0.0.1") return undefined;
    return url;
  } catch {
    return undefined;
  }
}

async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const url = localDatabaseUrl();
  if (!url) throw new Error("APL-2733 change-password needs a localhost DATABASE_URL");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Same scrypt shape as src/lib/auth.ts hashPassword. Defaults are N=16384, r=8, p=1. */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

/** One verified ZZ-TEST person and a session cookie. Bad passwords never replace this hash. */
async function createChangeUser(): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const passwordHash = await hashPassword(VALID_PASSWORD);
  const userId = `zz2733${randomBytes(8).toString("hex")}`;
  await withDb(async (client) => {
    const ws = await client.query<{ id: string }>('SELECT id FROM "Workspace" ORDER BY "createdAt" ASC LIMIT 1');
    let workspaceId = ws.rows[0]?.id;
    if (!workspaceId) {
      workspaceId = `zzws${randomBytes(8).toString("hex")}`;
      await client.query('INSERT INTO "Workspace" (id, name) VALUES ($1, $2)', [workspaceId, "ZZ-TEST Workspace"]);
    }
    await client.query(
      'INSERT INTO "User" (id, "workspaceId", email, name, "passwordHash", "emailVerifiedAt", "orgRole") VALUES ($1, $2, $3, $4, $5, NOW(), \'MEMBER\')',
      [userId, workspaceId, CHANGE_EMAIL, "ZZ-TEST Change password", passwordHash],
    );
    await client.query(
      'INSERT INTO "Session" (id, "userId", "tokenHash", "expiresAt", "userAgent") VALUES ($1, $2, $3, $4, $5)',
      [`zzses${randomBytes(8).toString("hex")}`, userId, tokenHash, new Date(Date.now() + 30 * 24 * 3600_000), "Playwright"],
    );
  });
  watched.add(CHANGE_EMAIL);
  return token;
}

/** Removes this email's user row, and the audit or action rows that point at it. No other person is touched. */
async function deleteOnlyThisUser(email: string) {
  const url = localDatabaseUrl();
  if (!url) return;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const found = await client.query<{ id: string }>('SELECT id FROM "User" WHERE email = $1', [email]);
    if (found.rowCount !== 1) return;
    const id = found.rows[0].id;
    await client.query('DELETE FROM "AuditLog" WHERE "actorId" = $1', [id]);
    await client.query('DELETE FROM "ActionLog" WHERE "actorId" = $1 OR "undoneById" = $1', [id]);
    await client.query('DELETE FROM "User" WHERE id = $1', [id]);
  } finally {
    await client.end();
  }
}

for (const size of SIZES) {
  for (const failure of FAILURES) {
    test(`sign-up ${failure.label} on ${size.label} shows the password message once qa:TC missing`, async ({ page }) => {
      const who = person(`signup ${failure.label} ${size.label}`);
      await openSignUp(page, size);
      await fillSignUp(page, who.name, who.email, failure.password);
      const [response] = await Promise.all([
        page.waitForResponse((res) => res.url().includes("/api/auth/signup") && res.request().method() === "POST"),
        page.getByRole("button", { name: "Create account" }).click(),
      ]);
      expect(response.status(), who.email).toBe(400);
      await expect(page).toHaveURL(/\/signup$/);
      await expect(errorAlert(page)).toHaveCount(1);
      expect(await passwordMessageCount(page), who.email).toBe(1);
      await saveEvidence(page, response, `signup-${failure.key}-${size.label}`);
    });

    test(`reset-password ${failure.label} on ${size.label} shows the password message once qa:TC missing`, async ({ page }) => {
      await openReset(page, size);
      await fillReset(page, failure.password);
      const [response] = await Promise.all([
        page.waitForResponse((res) => res.url().includes("/api/auth/reset-password") && res.request().method() === "POST"),
        page.getByRole("button", { name: "Save and sign in" }).click(),
      ]);
      expect(response.status()).toBe(400);
      await expect(page).toHaveURL(/\/reset\?/);
      await expect(errorAlert(page)).toHaveCount(1);
      expect(await passwordMessageCount(page)).toBe(1);
      await saveEvidence(page, response, `reset-${failure.key}-${size.label}`);
    });

    test(`change-password ${failure.label} on ${size.label} shows the password message once qa:TC missing`, async ({ page }) => {
      await openChange(page, size);
      await fillChange(page, failure.password);
      const [response] = await Promise.all([
        page.waitForResponse((res) => res.url().includes("/api/profile/password") && res.request().method() === "POST"),
        page.getByRole("button", { name: "Change password" }).click(),
      ]);
      expect(response.status()).toBe(400);
      await expect(page).toHaveURL(/\/profile$/);
      await expect(page.getByRole("status").filter({ hasText: PASSWORD_MESSAGE })).toHaveCount(1);
      expect(await passwordMessageCount(page)).toBe(1);
      await saveEvidence(page, response, `change-${failure.key}-${size.label}`);
    });
  }

  test(`sign-up valid password on ${size.label} shows no error qa:TC missing`, async ({ page }) => {
    const who = person(`valid signup ${size.label}`);
    await page.route("**/api/auth/signup", async (route) => {
      const body = route.request().postDataJSON() as { password?: string };
      if (body.password !== VALID_PASSWORD) {
        await route.continue();
        return;
      }
      // Do not forward. A 201 here is the stub, not an account.
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ status: "check_email" }),
      });
    });
    await openSignUp(page, size);
    await fillSignUp(page, who.name, who.email, VALID_PASSWORD);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page).toHaveURL(/\/check-email$/);
    await expect(errorAlert(page)).toHaveCount(0);
    const url = localDatabaseUrl();
    if (url) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        const found = await client.query('SELECT id FROM "User" WHERE email = $1', [who.email]);
        expect(found.rowCount, who.email).toBe(0);
      } finally {
        await client.end();
      }
    }
  });

  test(`reset-password valid password on ${size.label} shows no error qa:TC missing`, async ({ page }) => {
    await page.route("**/api/auth/reset-password", async (route) => {
      const body = route.request().postDataJSON() as { password?: string };
      if (body.password !== VALID_PASSWORD) {
        await route.continue();
        return;
      }
      // Do not forward. A 200 here is the stub, not a password change.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "password_changed" }),
      });
    });
    await openReset(page, size);
    await fillReset(page, VALID_PASSWORD);
    await page.getByRole("button", { name: "Save and sign in" }).click();
    await expect(page).toHaveURL(/\/signin\?reset=1/);
    await expect(errorAlert(page)).toHaveCount(0);
  });

  test(`change-password valid password on ${size.label} shows no error qa:TC missing`, async ({ page }) => {
    await page.route("**/api/profile/password", async (route) => {
      const body = route.request().postDataJSON() as { password?: string };
      if (body.password !== VALID_PASSWORD) {
        await route.continue();
        return;
      }
      // Do not forward. A 200 here is the stub, not a password change.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "password_changed" }),
      });
    });
    await openChange(page, size);
    await fillChange(page, VALID_PASSWORD);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Password changed." })).toHaveCount(1);
    expect(await passwordMessageCount(page)).toBe(0);
    await expect(page).toHaveURL(/\/profile$/);
  });
}
