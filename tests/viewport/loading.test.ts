// SHO-BUG-12 (APL-2647): a slow first load shows the 400 ms skeleton, not "Could not reach the server.".
// A real network error or a 5xx still shows LoadFailed with Retry. Runs in the browser suite (npm run test:viewport),
// against a local server on a TEST database, like the phone-size checks.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { account, BASE, PW, project, superAdmin, task } from "../helpers";

let browser: Browser;
let ctx: BrowserContext;
let projectId = "";
let personId = "";

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error(`Refusing to run the loading suite against ${BASE}: use a local server with a test database.`);
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const root = await superAdmin();
  const editor = await account("loadeditor");
  const p = await project(root, root, [{ who: editor }]);
  await task(root, p.id, { title: "A task to show" });
  projectId = p.id;
  personId = editor.id;
  ctx = await browser.newContext({ viewport: { width: 1024, height: 800 }, baseURL: BASE });
  const r = await ctx.request.post("/api/auth/signin", { data: { email: "root.test@aplyd.com", password: PW } });
  expect(r.ok(), "sign in for the loading suite").toBe(true);
}, 60000);
afterAll(async () => { await ctx?.close(); await browser?.close(); });

// Each screen and the API reads its first paint waits on.
const SCREENS: { name: string; path: () => string; api: () => RegExp }[] = [
  { name: "ProjectView", path: () => `/projects/${projectId}`, api: () => new RegExp(`/api/projects/${projectId}(/tasks|\\?|$)`) },
  { name: "Activity", path: () => `/projects/${projectId}/activity`, api: () => new RegExp(`/api/projects/${projectId}/activity`) },
  { name: "Members", path: () => `/projects/${projectId}/members`, api: () => new RegExp(`/api/projects/${projectId}$`) },
  { name: "Trash", path: () => `/projects/${projectId}/trash`, api: () => new RegExp(`/api/projects/${projectId}(/trash)?$`) },
  { name: "Person", path: () => `/team/${personId}`, api: () => new RegExp(`/api/team/${personId}$`) },
];

const DELAY = 2500;
const loadFailed = (page: Page) => page.getByText("Could not reach the server.");

async function open(path: string, api: RegExp, handle: (route: Parameters<Parameters<Page["route"]>[1]>[0]) => Promise<void>) {
  const page = await ctx.newPage();
  await page.route((url) => api.test(url.pathname + (url.search ? "?" : "")), handle);
  await page.goto(path, { waitUntil: "domcontentloaded" });
  return page;
}

describe("slow first load shows the skeleton", () => {
  for (const s of SCREENS) {
    it(`${s.name}: a response slower than 400 ms shows the Skeleton, not LoadFailed`, async () => {
      const page = await open(s.path(), s.api(), async (route) => { await new Promise((r) => setTimeout(r, DELAY)); await route.continue(); });
      try {
        // The Skeleton draws its grey rows after 400 ms; the request is still in flight here.
        await page.locator(".skel-wrap .skel-row").first().waitFor({ state: "visible", timeout: DELAY - 500 });
        expect(await loadFailed(page).count()).toBe(0);
        expect(await page.getByText("Loading…").count()).toBe(0);
        // Once the answer arrives, the skeleton goes and no failure was ever shown.
        await page.waitForFunction(() => !document.querySelector(".skel-wrap"), undefined, { timeout: 15000 });
        expect(await loadFailed(page).count()).toBe(0);
      } finally { await page.close(); }
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
  }
  it("ProjectView: a 5xx shows LoadFailed, and Retry loads the project once the server answers", async () => {
    let fail = true;
    const page = await open(SCREENS[0].path(), SCREENS[0].api(), (route) => (fail ? route.fulfill({ status: 503, contentType: "application/json", body: "{}" }) : route.continue()));
    try {
      await loadFailed(page).waitFor({ state: "visible", timeout: 15000 });
      fail = false;
      await page.getByRole("button", { name: "Retry" }).click();
      await page.getByText("A task to show").waitFor({ state: "visible", timeout: 15000 });
      expect(await loadFailed(page).count()).toBe(0);
    } finally { await page.close(); }
  });
});
