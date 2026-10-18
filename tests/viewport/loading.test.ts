// SHO-BUG-12 (APL-2647): a slow first load shows the 400 ms skeleton, not "Could not reach the server.".
// A real network error or a 5xx still shows LoadFailed with Retry. Runs in the browser suite (npm run test:viewport),
// against a local server on a TEST database, like the phone-size checks.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Route } from "playwright-core";
import { account, BASE, PW, project, superAdmin, task } from "../helpers";

let browser: Browser;
let ctx: BrowserContext;
let projectId = "";
let personId = "";
let personName = "";

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error(`Refusing to run the loading suite against ${BASE}: use a local server with a test database.`);
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const root = await superAdmin();
  const editor = await account("loadeditor");
  const p = await project(root, root, [{ who: editor }]);
  await task(root, p.id, { title: "A task to show" });
  projectId = p.id;
  personId = editor.id;
  personName = editor.name;
  ctx = await browser.newContext({ viewport: { width: 1024, height: 800 }, baseURL: BASE });
  const r = await ctx.request.post("/api/auth/signin", { data: { email: "root.test@aplyd.com", password: PW } });
  expect(r.ok(), "sign in for the loading suite").toBe(true);
}, 60000);
afterAll(async () => { await ctx?.close(); await browser?.close(); });

// Each screen, the API reads its first paint waits on, and what it shows once those arrive.
const SCREENS: { name: string; path: () => string; api: () => RegExp; ready: (page: Page) => Locator }[] = [
  { name: "ProjectView", path: () => `/projects/${projectId}`, api: () => new RegExp(`/api/projects/${projectId}(/tasks|\\?|$)`), ready: (page) => page.getByText("A task to show") },
  { name: "Activity", path: () => `/projects/${projectId}/activity`, api: () => new RegExp(`/api/projects/${projectId}/activity`), ready: (page) => page.locator(".actlist").or(page.getByText("Nothing has happened yet.")).first() },
  { name: "Members", path: () => `/projects/${projectId}/members`, api: () => new RegExp(`/api/projects/${projectId}$`), ready: (page) => page.locator(".list .item").filter({ hasText: personName }).first() },
  { name: "Trash", path: () => `/projects/${projectId}/trash`, api: () => new RegExp(`/api/projects/${projectId}(/trash)?$`), ready: (page) => page.getByText("Trash is empty.") },
  { name: "Person", path: () => `/team/${personId}`, api: () => new RegExp(`/api/team/${personId}$`), ready: (page) => page.getByRole("heading", { name: personName }) },
];

// A cold `next dev` compiles each page and API route on its first request, which can take longer than a test.
// Open every screen once, unintercepted, so the timed tests below measure the app and not the compiler.
beforeAll(async () => {
  for (const s of SCREENS) {
    const page = await ctx.newPage();
    try {
      await page.goto(s.path(), { waitUntil: "domcontentloaded", timeout: 120000 });
      await s.ready(page).waitFor({ state: "visible", timeout: 120000 });
    } finally { await page.close(); }
  }
}, 600000);

const HOLD = 2000; // how long the first answer is held back: well past the Skeleton's 400 ms
const loadFailed = (page: Page) => page.getByText("Could not reach the server.");

async function open(path: string, api: RegExp, handle: (route: Route) => Promise<void>) {
  const page = await ctx.newPage();
  await page.route((url) => api.test(url.pathname + (url.search ? "?" : "")), handle);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  return page;
}

// Watches every animation frame from the moment the Skeleton's rows appear until `window.__released` is set:
// counts frames where the rows were missing, LoadFailed showed, or the old "Loading…" text came back.
// Resolves true once the rows appear, or false if they have not after 10 s.
function watchLoading() {
  const w = window as unknown as { __released?: boolean; __watch: { frames: number; gaps: number; failed: number; text: number } };
  w.__watch = { frames: 0, gaps: 0, failed: 0, text: 0 };
  return new Promise<boolean>((started) => {
    let seen = false;
    setTimeout(() => started(false), 10000);
    const tick = () => {
      const rows = document.querySelectorAll(".skel-wrap .skel-row").length > 0;
      const body = document.body.innerText;
      if (!seen && rows) { seen = true; started(true); }
      if (seen && !w.__released) {
        w.__watch.frames++;
        if (!rows) w.__watch.gaps++;
        if (body.includes("Could not reach the server.")) w.__watch.failed++;
        if (body.includes("Loading…")) w.__watch.text++;
      }
      if (!w.__released) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

describe("slow first load shows the skeleton", () => {
  for (const s of SCREENS) {
    it(`${s.name}: a response slower than 400 ms keeps the Skeleton up the whole time, then shows the data`, async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const page = await open(s.path(), s.api(), async (route) => { await gate; await route.continue(); });
      try {
        // Every first read is held, so after 400 ms the Skeleton draws its grey rows.
        expect(await page.evaluate(watchLoading), "the Skeleton's grey rows appear while the first answer is held").toBe(true);
        // Hold well past 400 ms while every frame is checked.
        await page.waitForTimeout(HOLD);
        await page.evaluate(() => { (window as unknown as { __released: boolean }).__released = true; });
        const w = await page.evaluate(() => (window as unknown as { __watch: { frames: number; gaps: number; failed: number; text: number } }).__watch);
        expect(w.frames, "frames watched while loading").toBeGreaterThan(10);
        expect(w.gaps, "frames with no Skeleton rows while loading").toBe(0);
        expect(w.failed, "frames showing LoadFailed while loading").toBe(0);
        expect(w.text, "frames showing 'Loading…' text").toBe(0);
        // Let the answers through: the data appears and the Skeleton goes.
        release();
        await s.ready(page).waitFor({ state: "visible", timeout: 15000 });
        await page.waitForFunction(() => !document.querySelector(".skel-wrap"), undefined, { timeout: 15000 });
        expect(await loadFailed(page).count()).toBe(0);
        expect(await page.getByText("Loading…").count()).toBe(0);
      } finally { release(); await page.close(); }
    });
  }
});

describe("a real failure still shows LoadFailed", () => {
  for (const s of SCREENS) {
    it(`${s.name}: a network error shows "Could not reach the server." with Retry`, async () => {
      const page = await open(s.path(), s.api(), (route) => route.abort("internetdisconnected"));
      try {
        await loadFailed(page).waitFor({ state: "visible", timeout: 15000 });
        expect(await page.getByRole("button", { name: "Retry" }).count()).toBe(1);
      } finally { await page.close(); }
    });
    it(`${s.name}: a 5xx shows LoadFailed, and Retry loads the screen once the server answers`, async () => {
      let fail = true;
      const page = await open(s.path(), s.api(), (route) => (fail ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" }) : route.continue()));
      try {
        await loadFailed(page).waitFor({ state: "visible", timeout: 15000 });
        fail = false;
        await page.getByRole("button", { name: "Retry" }).click();
        await s.ready(page).waitFor({ state: "visible", timeout: 15000 });
        expect(await loadFailed(page).count()).toBe(0);
      } finally { await page.close(); }
    });
  }
});
