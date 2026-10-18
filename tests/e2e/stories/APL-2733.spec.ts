// APL-2733. A bad password on the sign-up page shows the password message once.
// Desktop and 390x844. ZZ-TEST names, nakul17+ aliases. workers=1 (playwright.config.ts).
// A valid password is not sent to the server, so no account is created. If one is, only that row is removed.
import { test, expect, type Page } from "@playwright/test";
import pg from "pg";

const PASSWORD_MESSAGE = "Use at least 8 characters, with at least one letter and one number.";
const VALID_PASSWORD = "goodpass7";

const SIZES = [
  { label: "desktop", width: 1280, height: 800 },
  { label: "390x844", width: 390, height: 844 },
] as const;

const FAILURES = [
  { label: "short password", password: "short1" },
  { label: "long password", password: `${"a".repeat(128)}1` },
  { label: "no digit", password: "abcdefgh" },
  { label: "no letter", password: "12345678" },
] as const;

const watched = new Set<string>();
let seq = 0;

/** The route announcer is also role=alert. It is not the sign-up error. */
const errorAlert = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

test.beforeAll(() => {
  if (!process.env.BASE_URL && !process.env.TASKBOARD_URL) {
    test.skip(true, "APL-2733 needs BASE_URL or TASKBOARD_URL");
  }
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

/** Removes the sign-up row for this email, and the audit row that points at it. No other person is touched. */
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
    test(`${failure.label} on ${size.label} shows the password message once qa:TC missing`, async ({ page }) => {
      const who = person(`${failure.label} ${size.label}`);
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
    });
  }

  test(`valid password on ${size.label} shows no error qa:TC missing`, async ({ page }) => {
    const who = person(`valid ${size.label}`);
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
}
