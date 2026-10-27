import { existsSync, mkdirSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { BASE, PW, type Account } from "../../helpers";
import { workloadFixture } from "../../workload-2589-fixtures";

if (new URL(BASE).hostname !== "localhost") throw new Error("Workload browser acceptance requires localhost, never production.");
let browser: Browser;
let f: Awaited<ReturnType<typeof workloadFixture>>;
beforeAll(async () => {
  const paths = [process.env.PW_CHROMIUM, "/usr/bin/google-chrome", "/usr/bin/chromium"].filter((p): p is string => !!p);
  browser = await chromium.launch({ executablePath: paths.find(p => existsSync(p)), args: ["--no-sandbox"] });
  mkdirSync("workload-ui-previews", { recursive: true });
  f = await workloadFixture();
}, 120000);
afterAll(async () => { try { await f?.cleanup(); } finally { await browser?.close(); } }, 120000);
async function signedIn(who: Account, width: number): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport: { width, height: 844 }, hasTouch: width < 600, isMobile: width < 600 });
  expect((await ctx.request.post("/api/auth/signin", { data: { email: who.email, password: PW } })).ok()).toBe(true);
  return ctx;
}
it.each([390, 1280])("shows readable %i px workload rows/cards and opens the matching count", async width => {
  const ctx = await signedIn(f.lead, width);
  const page = await ctx.newPage();
  try {
    expect((await page.goto("/workload", { waitUntil: "load" }))?.ok()).toBe(true);
    const count = page.getByRole("link", { name: `${f.worker.name}: 1 overdue`, exact: true });
    await count.waitFor({ state: "visible", timeout: 30000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const geometry = await count.boundingBox();
    expect(geometry!.width).toBeGreaterThanOrEqual(44); expect(geometry!.height).toBeGreaterThanOrEqual(44);
    expect(await count.evaluate(el => getComputedStyle(el.closest("tr")!).display)).toBe(width < 768 ? "grid" : "table-row");
    if (width < 768) {
      const nameWidth = await count.evaluate(el => {
        const row = el.closest("tr")!, name = row.querySelector("th")!;
        const style = getComputedStyle(row);
        return { name: name.getBoundingClientRect().width, available: row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
      });
      expect(nameWidth.name).toBeGreaterThanOrEqual(nameWidth.available - 2);
    }
    expect(await page.getByRole("table").textContent()).not.toContain(f.outsider.name);
    await page.screenshot({ path: `workload-ui-previews/workload-${width}-people.png`, fullPage: false });
    await count.click();
    const tasks = page.locator("#workload-tasks");
    await tasks.getByRole("button", { name: `ZZ-TEST Workload blocked parent ${f.run}`, exact: true }).waitFor({ state: "visible", timeout: 30000 });
    expect(await tasks.locator(".workload-task-title").count()).toBe(1);
    expect(new URL(page.url()).searchParams.get("f")).toBe("overdue");
    expect(new URL(page.url()).searchParams.get("assignee")).toBe(f.worker.id);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await tasks.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `workload-ui-previews/workload-${width}-tasks.png`, fullPage: false });
  } finally { await ctx.close(); }
}, 120000);
it("reassigns through Task details, exposes Undo and refreshes the scoped list without a document reload", async () => {
  const ctx = await signedIn(f.root, 390);
  const page = await ctx.newPage();
  try {
    await page.goto(`/workload?assignee=${f.worker.id}&f=blocked#workload-tasks`, { waitUntil: "load" });
    const title = `ZZ-TEST Workload blocked parent ${f.run}`;
    const open = page.locator("#workload-tasks").getByRole("button", { name: title, exact: true });
    await open.waitFor({ state: "visible", timeout: 30000 });
    await page.evaluate(() => { (window as unknown as { __workloadSameDocument: boolean }).__workloadSameDocument = true; });
    await open.click();
    const sheet = page.getByRole("dialog", { name: "Task", exact: true });
    const assignee = sheet.getByRole("combobox", { name: "Assignee", exact: true });
    await assignee.waitFor({ state: "visible", timeout: 30000 });
    expect(await assignee.locator(`option[value="${f.viewer.id}"]`).count()).toBe(0);
    expect(await assignee.locator(`option[value="${f.outsider.id}"]`).count()).toBe(0);
    const assigned = page.waitForResponse(r => new URL(r.url()).pathname === `/api/tasks/${f.parent}/assign` && r.request().method() === "POST");
    await assignee.selectOption(f.lead.id); expect((await assigned).status()).toBe(200);
    await page.waitForFunction(id => document.querySelector<HTMLSelectElement>('[aria-label="Assignee"]')?.value === id, f.lead.id);
    // The existing task dialog sits above the global Undo toast; close it before using Undo.
    await sheet.getByRole("button", { name: "Close", exact: true }).click();
    await sheet.waitFor({ state: "detached", timeout: 15000 });
    const undo = page.getByRole("button", { name: "Undo", exact: true });
    await undo.waitFor({ state: "visible", timeout: 10000 });
    const undone = page.waitForResponse(r => /\/api\/actions\/[^/]+\/undo$/.test(new URL(r.url()).pathname) && r.request().method() === "POST");
    await undo.click(); expect((await undone).status()).toBe(200);
    await page.locator("#workload-tasks").getByRole("button", { name: title, exact: true }).waitFor({ state: "visible", timeout: 30000 });
    expect((await f.root.c.get(`/api/tasks/${f.parent}`)).json.task.assignee.id).toBe(f.worker.id);
    expect(await page.evaluate(() => (window as unknown as { __workloadSameDocument: boolean }).__workloadSameDocument)).toBe(true);
    await page.screenshot({ path: "workload-ui-previews/workload-390-after-undo.png", fullPage: false });
  } finally { await ctx.close(); }
}, 180000);
