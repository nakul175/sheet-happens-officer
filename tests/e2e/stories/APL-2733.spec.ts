// APL-2733. A bad password shows the password message once.
// Sign-up, reset-password and change-password. Desktop and 390x844.
// ZZ-TEST names, nakul17+ aliases. workers=1 (playwright.config.ts).
// A valid password is not sent to the server, and a bad one is refused before the account is touched.
// The change-password page signs in as an existing account (SHARD_EMAIL / SHARD_PASS, as staging-e2e.yml
// passes each shard). The spec creates no account, reads no files, and writes no database.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type APIRequestContext, type APIResponse, type Page, type Response } from "@playwright/test";

const PASSWORD_MESSAGE = "Use at least 8 characters, with at least one letter and one number.";
const VALID_PASSWORD = "goodpass7";
const FAKE_RESET_TOKEN = "zz-test-reset-token-0123456789";
// Repo-relative. Override with APL_2733_EVIDENCE when a run wants a different folder.
const EVIDENCE = process.env.APL_2733_EVIDENCE ?? path.join("test-results", "apl-2733");

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

let seq = 0;
let changeSession = "";
const evidenceIndex: { slug: string; body: unknown }[] = [];

/** Same gate as the other story specs: an unset SHO_QA_PASS skips the file. */
function gateFile() {
  test.beforeAll(async ({ request }) => {
    const pass = process.env.SHO_QA_PASS ?? "";
    test.skip(!pass, "APL-2733: Set SHO_QA_PASS (the password for nakul17+ aliases).");
    if (!pass) return;
    const origin = process.env.BASE_URL || process.env.TASKBOARD_URL;
    test.skip(!origin, "APL-2733 needs BASE_URL or TASKBOARD_URL");
    if (!origin) return;
    const email = process.env.SHARD_EMAIL ?? "";
    const password = process.env.SHARD_PASS ?? "";
    if (!email || !password) throw new Error("APL-2733: set SHARD_EMAIL and SHARD_PASS (an existing verified account) for change-password.");
    changeSession = await signIn(request, email, password);
  });
}

gateFile();

function person(label: string) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24) || "case";
  const email = `nakul17+zz2733-${slug}-${(seq++).toString(36)}-${Date.now().toString(36)}@aplyd.com`;
  return { name: `ZZ-TEST ${label}`, email };
}

/** The route announcer is also role=alert. The password error is the alert that says the message. */
const passwordAlert = (page: Page) => page.getByRole("alert").filter({ hasText: PASSWORD_MESSAGE });

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

function sessionValue(res: APIResponse): string {
  for (const header of res.headersArray()) {
    if (header.name.toLowerCase() !== "set-cookie") continue;
    const match = header.value.match(/(?:^|; )sho_session=([^;]*)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  throw new Error("APL-2733 sign-in did not return a session cookie");
}

/** Session for an existing account. Bad new passwords fail validation before the current one is checked. */
async function signIn(request: APIRequestContext, email: string, password: string): Promise<string> {
  const sign = await request.post("/api/auth/signin", { data: { email, password } });
  expect(sign.status(), "APL-2733 sign-in as SHARD_EMAIL").toBe(200);
  return sessionValue(sign);
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
      await expect(passwordAlert(page)).toHaveCount(1);
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
      await expect(passwordAlert(page)).toHaveCount(1);
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
    await expect(passwordAlert(page)).toHaveCount(0);
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
    await expect(passwordAlert(page)).toHaveCount(0);
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
