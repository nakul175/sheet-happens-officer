// @readonly release checks. Safe to run after a production deploy.
//
// These tests stay signed out. Sign-in creates a session row, writes an audit row, deletes
// login-attempt rows, and can update orgRole (src/app/api/auth/signin/route.ts, src/lib/auth.ts).
// currentUser() also writes session.lastSeenAt. There is no ZZ-TEST data and no POST, PUT, PATCH,
// or DELETE. tests/e2e/smoke/guard.ts aborts any non-GET request and fails the test.
import { test, expect, isStagingHost } from "./guard";

test("health endpoint returns 200", { tag: "@readonly" }, async ({ page }) => {
  const res = await page.goto("/api/health");
  expect(res?.status()).toBe(200);
  const body = (await res?.json()) as { ok?: boolean };
  expect(body.ok).toBe(true);
  const text = JSON.stringify(body);
  expect(text.includes("password")).toBe(false);
});

test("sign-in page renders", { tag: "@readonly" }, async ({ page }) => {
  await page.goto("/signin");
  await expect(page).toHaveURL(/\/signin$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Work email")).toBeVisible();
  await expect(page.getByLabel("Password")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled();
  // The form is not filled and not submitted. A submit would POST /api/auth/signin and fail the GET guard.
});

test("public pages render", { tag: "@readonly" }, async ({ page }) => {
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await page.goto("/forgot");
  await expect(page.getByRole("heading", { name: "Forgot password" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to sign in" })).toBeVisible();
});

test("static assets load", { tag: "@readonly" }, async ({ page }) => {
  const logo = await page.goto("/logo-mark.svg");
  expect(logo?.status()).toBe(200);
  expect(logo?.headers()["content-type"] ?? "").toMatch(/svg/);
  const icon = await page.goto("/icons/icon-192.png");
  expect(icon?.status()).toBe(200);
  expect(icon?.headers()["content-type"] ?? "").toMatch(/png/);
});

test("protected routes redirect or return 401", { tag: "@readonly" }, async ({ page }) => {
  for (const path of ["/", "/projects", "/team", "/usage", "/search", "/audit"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/signin$/);
  }
  for (const path of ["/api/auth/me", "/api/projects", "/api/notifications", "/api/usage", "/api/search"]) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(401);
  }
});

test("staging host guard allows only staging hosts", { tag: "@readonly" }, async () => {
  // No request. The same predicate gates every @write test before sign-in.
  expect(isStagingHost("staging.sheethappensofficer.com")).toBe(true);
  expect(isStagingHost("pr1.staging.sheethappensofficer.com")).toBe(true);
  expect(isStagingHost("pr8.staging.sheethappensofficer.com")).toBe(true);
  expect(isStagingHost("sheethappensofficer.com")).toBe(false);
  expect(isStagingHost("www.sheethappensofficer.com")).toBe(false);
  expect(isStagingHost("app.sheethappensofficer.com")).toBe(false);
  expect(isStagingHost("localhost")).toBe(false);
  expect(isStagingHost("127.0.0.1")).toBe(false);
  expect(isStagingHost("staging.sheethappensofficer.com.evil.example")).toBe(false);
  expect(isStagingHost("notstaging.sheethappensofficer.com")).toBe(false);
});
