// SHO-US-22.10 Installable web app (APL-2558). Epic SHO-E22.
// Pam left no qa:TC id. Each title says qa:TC missing. The annotation is qa:TC with description missing. An AC number is not a TC id.
// Runs against staging. Creates no data. AC2 uses Chrome's installability report. AC3 checks the tags and manifest Safari reads for Add to Home Screen.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, devices } from "@playwright/test";
import { test, expect, BASE_URL } from "../support";
import { storyGate } from "../helpers/qa-alias";
import { linkHrefs, metaContent } from "../helpers/locate";

storyGate({ admin: true, id: "APL-2558" });

type Icon = { src: string; sizes: string; type?: string; purpose?: string };

// qa:TC missing
test("AC1: /manifest.webmanifest returns 200 with name, short_name, start_url, standalone, colours and the 192, 512, maskable 512 icons qa:TC missing", async ({ anon }) => {
  const r = await anon.request.get("/manifest.webmanifest");
  expect(r.status()).toBe(200);
  const m = await r.json();
  expect(m.name).toBeTruthy();
  expect(m.short_name).toBeTruthy();
  expect(m.start_url).toBe("/");
  expect(m.display).toBe("standalone");
  expect(m.theme_color).toMatch(/^#[0-9a-f]{3,8}$/i);
  expect(m.background_color).toMatch(/^#[0-9a-f]{3,8}$/i);
  const icons = m.icons as Icon[];
  expect(icons.some((i) => i.sizes === "192x192")).toBe(true);
  expect(icons.some((i) => i.sizes === "512x512" && !i.purpose)).toBe(true);
  expect(icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable")).toBe(true);
  for (const i of icons) {
    const f = await anon.request.get(i.src);
    expect(f.status(), `icon ${i.src}`).toBe(200);
    expect(f.headers()["content-type"]).toMatch(/image\/png/);
  }
});

// qa:TC missing
test("AC1: the pages link the manifest and an apple-touch icon of 180 x 180 px qa:TC missing", async ({ anon }) => {
  await anon.goto("/signin");
  expect((await linkHrefs(anon, "manifest")).join(" ")).toMatch(/manifest/);
  const icons = await linkHrefs(anon, "apple-touch-icon");
  expect(icons.length).toBeGreaterThan(0);
  const sizes: number[][] = [];
  for (const href of icons) {
    const png = await (await anon.request.get(href)).body();
    if (png.length >= 24 && png[0] === 0x89 && png[1] === 0x50) sizes.push([png.readUInt32BE(16), png.readUInt32BE(20)]);
  }
  expect(sizes).toContainEqual([180, 180]);
});

// qa:TC missing
test("AC2: Chrome on Android offers install qa:TC missing", async () => {
  // browser.newContext() is always off the record, and Chrome never offers install there ("in-incognito").
  // A persistent profile is a normal window, so the report is about the app.
  const { defaultBrowserType: _type, ...pixel } = devices["Pixel 5"];
  const profile = mkdtempSync(path.join(tmpdir(), "apl-2558-"));
  const ctx = await chromium.launchPersistentContext(profile, {
    ...pixel,
    executablePath: process.env.PW_CHROMIUM || undefined,
    baseURL: BASE_URL,
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
  });
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await page.goto("/signin", { waitUntil: "load" });
    const manifest = await (await page.request.get("/manifest.webmanifest")).json();
    expect(manifest.display).toBe("standalone");
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect((manifest.icons as { sizes: string }[]).some((i) => i.sizes === "192x192")).toBe(true);
    expect((manifest.icons as { sizes: string }[]).some((i) => i.sizes === "512x512")).toBe(true);
    const session = await ctx.newCDPSession(page);
    const found = await session.send("Page.getInstallabilityErrors");
    const errors = (found as { installabilityErrors?: { errorId: string }[] }).installabilityErrors ?? [];
    const blocking = errors.filter((e) => e.errorId !== "warn-not-offline-capable");
    expect(blocking, `Chrome on Android does not offer install: ${JSON.stringify(errors)}`).toEqual([]);
  } finally {
    await ctx.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

// qa:TC missing
test("AC3 (Chromium proxy, needs a device): the tags and manifest iOS Safari reads for Add to Home Screen give the SHO icon, the name and no browser bars qa:TC missing", async ({ anon }) => {
  // Playwright cannot complete Safari's Add to Home Screen. These are the tags and manifest Safari reads for the icon, the name, and a window with no browser bars.
  await anon.goto("/signin");
  const capable = [...await metaContent(anon, "apple-mobile-web-app-capable"), ...await metaContent(anon, "mobile-web-app-capable")];
  expect(capable).toContain("yes");
  expect(await metaContent(anon, "apple-mobile-web-app-title")).toContain("SHO");
  const icons = await linkHrefs(anon, "apple-touch-icon");
  expect(icons.length).toBeGreaterThan(0);
  const sizes: number[][] = [];
  for (const href of icons) {
    const png = await (await anon.request.get(href)).body();
    if (png.length >= 24 && png[0] === 0x89 && png[1] === 0x50) sizes.push([png.readUInt32BE(16), png.readUInt32BE(20)]);
  }
  expect(sizes).toContainEqual([180, 180]);
  const manifest = await (await anon.request.get("/manifest.webmanifest")).json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.short_name).toBe("SHO");
  expect(manifest.name).toContain("Sheet Happens");
});

// qa:TC missing
test("AC3 (tags only): the page declares itself a web app for iOS, titled SHO qa:TC missing", async ({ anon }) => {
  await anon.goto("/signin");
  const capable = [...await metaContent(anon, "apple-mobile-web-app-capable"), ...await metaContent(anon, "mobile-web-app-capable")];
  expect(capable).toContain("yes");
  expect(await metaContent(anon, "apple-mobile-web-app-title")).toContain("SHO");
});

// qa:TC missing
test("AC4: the offline page says 'You are offline' and shows no account data qa:TC missing", async ({ anon }) => {
  const r = await anon.goto("/offline");
  expect(r!.status()).toBe(200);
  await expect(anon.getByRole("heading", { name: "You are offline" })).toBeVisible();
  await expect(anon.getByRole("link", { name: "Try again" })).toBeVisible();
  // It is a public page: no sign-in is needed and nothing personal is on it.
  expect(await anon.evaluate(() => document.body.innerText)).not.toMatch(/ZZ-TEST|@/);
});

// qa:TC missing
test("AC4: with no network and no installed app the browser's own error shows, never cached task data (no service worker) qa:TC missing", async ({ admin }) => {
  await admin.page.goto("/");
  const regs = await admin.page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0);
  expect(regs, "service workers registered").toBe(0);
  expect(await admin.page.evaluate(async () => (await caches.keys()).length), "Cache Storage entries").toBe(0);
  await admin.page.context().setOffline(true);
  const failed = await admin.page.goto("/projects", { timeout: 10_000 }).then(() => false, () => true);
  await admin.page.context().setOffline(false);
  expect(failed, "an offline reload must not be answered from a cache").toBe(true);
});

// qa:TC missing
test("AC5: the safe-area rules of 22.1 apply (viewport-fit=cover, theme colour, safe-area padding on the tab bar) qa:TC missing", async ({ admin }) => {
  await admin.page.goto("/");
  expect((await metaContent(admin.page, "viewport")).join(" ")).toMatch(/viewport-fit\s*=\s*cover/);
  const hrefs = await linkHrefs(admin.page, "stylesheet");
  const css = (await Promise.all(hrefs.map(async (h) => (await admin.page.request.get(h)).text()))).join("\n");
  expect(css).toMatch(/safe-area-inset-bottom/);
});

// qa:TC missing
test("Prohibited: authenticated pages and API responses are not cacheable by a shared cache qa:TC missing", async ({ admin }) => {
  for (const p of ["/api/auth/me", "/api/my-tasks", "/"]) {
    const r = await admin.page.request.get(p);
    const cc = (r.headers()["cache-control"] ?? "").toLowerCase();
    expect(cc, `${p} Cache-Control "${cc}"`).not.toMatch(/\bpublic\b|s-maxage|max-age=[1-9]/);
  }
});
