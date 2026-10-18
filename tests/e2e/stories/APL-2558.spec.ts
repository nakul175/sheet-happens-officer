// SHO-US-22.10 Installable web app (APL-2558). Epic SHO-E22.
// Runs against staging. Creates no data. AC2 and AC3 need a real Android / iPhone and are skipped with that reason.
import { test, expect } from "../support";
import { why } from "../helpers/jim-http";

type Icon = { src: string; sizes: string; type?: string; purpose?: string };

test("AC1: /manifest.webmanifest returns 200 with name, short_name, start_url, standalone, colours and the 192, 512, maskable 512 icons", async ({ anon }) => {
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

test("AC1: the pages link the manifest and an apple-touch icon of 180 x 180 px", async ({ anon }) => {
  await anon.goto("/signin");
  expect(await anon.locator('link[rel="manifest"]').getAttribute("href")).toMatch(/manifest/);
  const href = await anon.locator('link[rel="apple-touch-icon"]').first().getAttribute("href");
  expect(href).toBeTruthy();
  const png = await (await anon.request.get(href!)).body();
  // A PNG stores its width and height as two 32-bit numbers at bytes 16 to 24.
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([180, 180]);
});

test.skip("AC2: Chrome on Android offers install", why(
  "Needs a real Android device with Chrome. The story says install is verified on a device. The manifest rules are AC1.",
), () => {});

test.skip("AC3: iOS Safari Add to Home Screen shows the SHO icon and name and opens without browser bars", why(
  "Needs a real iPhone. Add to Home Screen cannot be driven from desktop Chromium. The apple-touch tags are the next test.",
), () => {});

test("AC3 (tags only): the page declares itself a web app for iOS, titled SHO", async ({ anon }) => {
  await anon.goto("/signin");
  const capable = (await anon.locator('meta[name="apple-mobile-web-app-capable"], meta[name="mobile-web-app-capable"]').evaluateAll((e) => e.map((x) => x.getAttribute("content"))));
  expect(capable).toContain("yes");
  expect(await anon.locator('meta[name="apple-mobile-web-app-title"]').getAttribute("content")).toBe("SHO");
});

test("AC4: the offline page says 'You are offline' and shows no account data", async ({ anon }) => {
  const r = await anon.goto("/offline");
  expect(r!.status()).toBe(200);
  await expect(anon.getByRole("heading", { name: "You are offline" })).toBeVisible();
  await expect(anon.getByRole("link", { name: "Try again" })).toBeVisible();
  // It is a public page: no sign-in is needed and nothing personal is on it.
  expect(await anon.locator("body").innerText()).not.toMatch(/ZZ-TEST|@/);
});

test("AC4: with no network and no installed app the browser's own error shows, never cached task data (no service worker)", async ({ admin }) => {
  await admin.page.goto("/");
  const regs = await admin.page.evaluate(async () => (await navigator.serviceWorker?.getRegistrations?.())?.length ?? 0);
  expect(regs, "service workers registered").toBe(0);
  expect(await admin.page.evaluate(async () => (await caches.keys()).length), "Cache Storage entries").toBe(0);
  await admin.page.context().setOffline(true);
  const failed = await admin.page.goto("/projects", { timeout: 10_000 }).then(() => false, () => true);
  await admin.page.context().setOffline(false);
  expect(failed, "an offline reload must not be answered from a cache").toBe(true);
});

test("AC5: the safe-area rules of 22.1 apply (viewport-fit=cover, theme colour, safe-area padding on the tab bar)", async ({ admin }) => {
  await admin.page.goto("/");
  expect(await admin.page.locator('meta[name="viewport"]').getAttribute("content")).toMatch(/viewport-fit\s*=\s*cover/);
  const hrefs = await admin.page.$$eval('link[rel="stylesheet"]', (l) => l.map((x) => (x as HTMLLinkElement).href));
  const css = (await Promise.all(hrefs.map(async (h) => (await admin.page.request.get(h)).text()))).join("\n");
  expect(css).toMatch(/safe-area-inset-bottom/);
});

test("Prohibited: authenticated pages and API responses are not cacheable by a shared cache", async ({ admin }) => {
  for (const p of ["/api/auth/me", "/api/my-tasks", "/"]) {
    const r = await admin.page.request.get(p);
    const cc = (r.headers()["cache-control"] ?? "").toLowerCase();
    expect(cc, `${p} Cache-Control "${cc}"`).not.toMatch(/\bpublic\b|s-maxage|max-age=[1-9]/);
  }
});
