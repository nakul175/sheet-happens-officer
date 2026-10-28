// qa:TC-APL2663-4941e080@v2
// Project B shows a loading state for the whole delay, and no frame shows project A's data under B.
// Local only, workers=1 (vitest.e2e.config.mts). ZZ-TEST projects, nakul17+ accounts. Run: npm run test:e2e
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { account, BASE, PW, task, type Account } from "../tests/helpers";

const SHOTS = "test-results/useGet-path-reset";
const ADMIN_EMAIL = "nakul17+zztest-admin@aplyd.com";
const WORKER_EMAIL = "nakul17+zztest-worker@aplyd.com";
const OUTSIDER_EMAIL = "nakul17+zztest-outsider@aplyd.com";
const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 800 },
] as const;

let browser: Browser;
let admin: Account;
let aId = "";
let bId = "";

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) {
    throw new Error(`Refusing to run against ${BASE}: this spec is local only.`);
  }
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || "/usr/local/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  admin = await account("nakul17+zztest-admin", ADMIN_EMAIL);
  const worker = await account("nakul17+zztest-worker", WORKER_EMAIL);
  const outsider = await account("nakul17+zztest-outsider", OUTSIDER_EMAIL);
  const a = await admin.c.post("/api/projects", {
    name: "ZZ-TEST-A",
    leaderId: admin.id,
    members: [{ userId: worker.id, role: "EDITOR" }],
  });
  expect(a.status, JSON.stringify(a.json)).toBe(201);
  aId = a.json.project.id as string;
  const b = await admin.c.post("/api/projects", {
    name: "ZZ-TEST-B",
    leaderId: admin.id,
    members: [{ userId: worker.id, role: "EDITOR" }],
  });
  expect(b.status, JSON.stringify(b.json)).toBe(201);
  bId = b.json.project.id as string;
  await task(admin, aId, { title: "ZZ-TEST-A-item1" });
  await task(admin, aId, { title: "ZZ-TEST-A-item2" });
  await task(admin, aId, { title: "ZZ-TEST-A-item3" });
  await task(admin, bId, { title: "ZZ-TEST-B-item1" });
  expect((await worker.c.get(`/api/projects/${aId}`)).status, "worker can open A").toBe(200);
  expect((await worker.c.get(`/api/projects/${bId}`)).status, "worker can open B").toBe(200);
  expect((await outsider.c.get(`/api/projects/${aId}`)).status, "outsider cannot open A").toBe(404);
}, 180000);

afterAll(async () => {
  await browser?.close();
  // Archive the projects this run created. The nakul17+ accounts stay so a later local run can sign in.
  for (const id of [aId, bId]) {
    if (id) await admin?.c.post(`/api/projects/${id}/archive`);
  }
});

/** Starts a frame poll, then client-navigates. Returns nothing to Node; the page records frames on window. */
function watchAndGo(href: string) {
  const w = window as unknown as {
    __shoSameDoc?: boolean;
    __shoStop?: boolean;
    __shoFrames?: { t: number; path: string; text: string; busy: boolean }[];
    __shoPoll?: ReturnType<typeof setInterval>;
    next?: { router?: { push?: (path: string) => void } };
  };
  w.__shoSameDoc = true;
  w.__shoStop = false;
  w.__shoFrames = [];
  const start = performance.now();
  const record = () => {
    if (w.__shoStop) return;
    const main = document.querySelector("main");
    w.__shoFrames!.push({
      t: Math.round(performance.now() - start),
      path: location.pathname,
      text: main?.innerText ?? "",
      busy: !!main?.querySelector(".skel-wrap, [aria-busy='true']"),
    });
  };
  const loop = () => {
    if (w.__shoStop) return;
    record();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  w.__shoPoll = setInterval(record, 50);
  const push = w.next?.router?.push;
  if (typeof push !== "function") throw new Error("missing client router");
  push(href);
}

async function open(viewport: { width: number; height: number }) {
  const ctx: BrowserContext = await browser.newContext({ viewport, baseURL: BASE });
  const signed = await ctx.request.post("/api/auth/signin", { data: { email: WORKER_EMAIL, password: PW } });
  expect(signed.ok(), "sign in").toBe(true);
  const page = await ctx.newPage();
  return { ctx, page };
}

async function prove(page: Page, shot: string) {
  await page.goto(`/projects/${aId}`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.getByText("ZZ-TEST-A-item1").waitFor({ state: "visible", timeout: 120000 });
  await page.getByText("ZZ-TEST-A-item3").waitFor({ state: "visible", timeout: 15000 });

  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  await page.route(
    (url) => url.pathname === `/api/projects/${bId}` || url.pathname.startsWith(`/api/projects/${bId}/`),
    async (route) => { await gate; await route.continue(); },
  );
  try {
    await page.evaluate(watchAndGo, `/projects/${bId}`);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SHOTS}/${shot}-loading.png`, fullPage: true });
    const frames = await page.evaluate(() => (window as unknown as { __shoFrames: { path: string; text: string; busy: boolean; t: number }[] }).__shoFrames);
    const onB = frames.filter((f) => f.path === `/projects/${bId}`);
    // The address bar can move a few frames before the project view swaps. Those frames still show project A's heading.
    // Once B's skeleton is up, no later frame may show A's items.
    const firstBusy = onB.findIndex((f) => f.busy);
    expect(firstBusy, `${shot}: skeleton appeared while B was held`).toBeGreaterThanOrEqual(0);
    // B's route is held, so the loading view must not wait for data. Bound the TIME, not the number of
    // samples: `record()` runs on every animation frame and every 50 ms, so a faster renderer packs more
    // samples into the same latency and a sample-index bound fails a machine for rendering quickly.
    expect(onB[firstBusy].t, `${shot}: view swapped to B promptly`).toBeLessThan(2000);
    const bView = onB.slice(firstBusy);
    expect(bView.length, `${shot}: frames of B's loading view`).toBeGreaterThan(5);
    const leaked = bView.filter((f) => /ZZ-TEST-A-item/.test(f.text));
    expect(leaked, `${shot}: a frame of B's view showed A's items`).toEqual([]);
    const loadingMain = page.locator("main").filter({ has: page.locator(".skel-wrap") });
    writeFileSync(`${SHOTS}/${shot}-loading.aria.yml`, await loadingMain.ariaSnapshot());

    release();
    await page.getByText("ZZ-TEST-B-item1").waitFor({ state: "visible", timeout: 15000 });
    await page.getByRole("heading", { name: "ZZ-TEST-B" }).waitFor({ state: "visible", timeout: 15000 });
    await page.waitForFunction(() => !document.querySelector("main .skel-wrap"), undefined, { timeout: 15000 });
    const shown = await page.locator("main").filter({ hasText: "ZZ-TEST-B-item1" }).innerText();
    expect(shown).toContain("ZZ-TEST-B-item1");
    expect(shown).not.toContain("ZZ-TEST-A");
    await page.screenshot({ path: `${SHOTS}/${shot}-loaded.png`, fullPage: true });
    expect(await page.evaluate(() => (window as unknown as { __shoSameDoc?: boolean }).__shoSameDoc), `${shot}: full document reload`).toBe(true);
  } finally {
    release();
    await page.evaluate(() => {
      const w = window as unknown as { __shoStop?: boolean; __shoPoll?: ReturnType<typeof setInterval> };
      w.__shoStop = true;
      if (w.__shoPoll) clearInterval(w.__shoPoll);
    }).catch(() => {});
  }
}

describe("useGet path reset on a project page", () => {
  // qa:TC-APL2663-4941e080@v2 — B's view shows the loading state for the whole delay, on desktop and mobile.
  it("project B view shows loading state during delay", async () => {
    const failures: string[] = [];
    for (const viewport of VIEWPORTS) {
      const { ctx, page } = await open(viewport);
      try {
        await prove(page, viewport.name);
      } catch (err) {
        failures.push(`${viewport.name}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      } finally {
        await ctx.close();
      }
    }
    expect(failures, failures.join("\n\n")).toEqual([]);
  });

  // qa:TC-APL2663-2437ecb8@v1 — skeleton is aria-busy, a polite region says Loading, focus stays, snapshot saved.
  it("loading skeleton is busy and announced", async () => {
    const { ctx, page } = await open({ width: 1280, height: 800 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    try {
      await page.goto(`/projects/${aId}`, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.getByText("ZZ-TEST-A-item1").waitFor({ state: "visible", timeout: 120000 });
      const projects = page.locator("aside nav").getByRole("link", { name: "Projects", exact: true });
      await projects.focus();
      await page.evaluate(() => { document.activeElement?.setAttribute("data-sho-focus", "stay"); });
      await page.route(
        (url) => url.pathname === `/api/projects/${bId}` || url.pathname.startsWith(`/api/projects/${bId}/`),
        async (route) => { await gate; await route.continue(); },
      );
      await page.evaluate(watchAndGo, `/projects/${bId}`);
      await page.locator("main .skel-wrap").waitFor({ state: "attached", timeout: 15000 });
      const live = page.locator("main [aria-live='polite']");
      expect(await live.count()).toBe(1);
      expect(await page.locator("main [aria-busy='true']").count()).toBeGreaterThan(0);
      expect(await live.innerText()).toContain("Loading");
      writeFileSync(`${SHOTS}/TC-APL2663-2437ecb8.aria.yml`, await page.locator("main").filter({ has: page.locator(".skel-wrap") }).ariaSnapshot());
      await page.screenshot({ path: `${SHOTS}/a11y-loading.png`, fullPage: true });
      release();
      await page.getByText("ZZ-TEST-B-item1").waitFor({ state: "visible", timeout: 15000 });
      await page.waitForFunction(() => !document.querySelector("main [aria-busy], main .skel-wrap"), undefined, { timeout: 15000 });
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-sho-focus"))).toBe("stay");
    } finally {
      release?.();
      await ctx.close();
    }
  });
});
