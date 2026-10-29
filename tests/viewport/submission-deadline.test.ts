// SHO-3054: isolated software-browser acceptance; no interactive Chrome/profile or production access.
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { account, BASE, cleanupZz, istDate, type Account } from "../helpers";
import { db } from "@/lib/db";
let browser: Browser, owner: Account, org = "", bid = "", bidName = "";
const projects: string[] = [];
const prefix = `ZZ-TEST 3054 UI ${Date.now()}`;
beforeAll(async () => {
  expect(["127.0.0.1", "localhost", "[::1]"].includes(new URL(BASE).hostname)).toBe(true);
  expect(["127.0.0.1", "localhost", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname)).toBe(true);
  expect(["/sho_test", "/sho_staging", "/sho_viewport"].includes(new URL(process.env.DATABASE_URL!).pathname)).toBe(true);
  owner = await account("zz3054browser");
  const o = await owner.c.post("/api/orgs", { name: `${prefix} Buyer` }); expect(o.status).toBe(201); org = o.json.organisation.id;
  const pipes = (await owner.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string; name: string }[];
  const p = pipes.find(p => p.key === "DEAL_BID")!; bid = p.id; bidName = p.name;
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  mkdirSync("test-results/viewport", { recursive: true });
}, 180000);
afterAll(async () => {
  await browser?.close();
  if (owner) await cleanupZz(projects, [owner]);
  if (org) { const sa = await import("../helpers").then(m => m.superAdmin()); expect((await sa.c.post(`/api/orgs/${org}/archive`, { archive: true })).status).toBe(200); }
}, 180000);
for (const width of [1280, 390]) it(`SHO-3054 create/edit/reload, explicit DST choice and legacy preservation at ${width}px`, async () => {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600 });
  const split = owner.c.cookie.indexOf("=");
  await context.addCookies([{ name: owner.c.cookie.slice(0, split), value: owner.c.cookie.slice(split + 1), url: BASE }]);
  const page = await context.newPage();
  const dialog = page.getByRole("dialog");
  try {
    await page.goto("/deals/new");
    await page.getByLabel("Deal name", { exact: true }).fill(`${prefix} ${width}`);
    await page.getByLabel("Organisation (buyer)", { exact: true }).selectOption(org);
    await page.getByLabel("Pipeline", { exact: true }).selectOption(bid);
    expect(await page.getByLabel("Submission timezone", { exact: true }).inputValue()).toBe("Asia/Kolkata");
    await page.getByText(/India time \(IST\)/).waitFor({ state: "visible" });
    await page.getByLabel("Submission deadline", { exact: true }).fill("2026-11-01");
    await page.getByLabel("Submission time", { exact: true }).fill("17:30");
    await page.getByLabel("Why are we pursuing this?", { exact: true }).fill("Exact cutoff acceptance");
    await page.getByLabel("First next step", { exact: true }).fill("ZZ-TEST next");
    await page.getByLabel("Next step due", { exact: true }).fill(istDate(3));
    const made = page.waitForResponse(r => r.url().endsWith("/api/deals") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Create deal", exact: true }).click();
    const result = await made; expect(result.status()).toBe(201); const id = (await result.json()).deal.id as string; projects.push(id);
    await page.waitForURL(url => url.pathname === `/projects/${id}`);
    await page.getByText("Submit by 2026-11-01 17:30 Asia/Kolkata (GMT+5:30)", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Edit details", exact: true }).click();
    await dialog.getByLabel("Submission time", { exact: true }).fill("09:15");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.reload();
    await page.getByText("Submit by 2026-11-01 09:15 Asia/Kolkata (GMT+5:30)", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Edit details", exact: true }).click();
    await dialog.getByLabel("Submission time", { exact: true }).fill("01:30");
    await dialog.getByLabel("Submission timezone", { exact: true }).fill("America/New_York");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText(/This local time occurs twice/).waitFor({ state: "visible" });
    await dialog.getByLabel("If this time repeats", { exact: true }).selectOption("later");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.reload();
    const label = "2026-11-01 01:30 America/New_York (GMT-5)";
    await page.getByText(`Submit by ${label}`, { exact: true }).waitFor({ state: "visible" });
    expect((await owner.c.get(`/api/projects/${id}`)).json.project.deal.details.submissionDeadlineAt).toBe("2026-11-01T06:30:00.000Z");
    await page.screenshot({ path: `test-results/viewport/deadline-detail-${width}-pass.png`, fullPage: true });
    await page.goto("/deals"); await page.getByRole("tab", { name: bidName, exact: true }).click();
    await page.getByRole("link", { name: `${prefix} ${width}`, exact: true }).waitFor({ state: "visible" });
    await page.getByText(`Submit by ${label}`, { exact: true }).first().waitFor({ state: "visible" });
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.getByRole("table").getByText(`Submit by ${label}`, { exact: true }).first().waitFor({ state: "visible" });
    await page.screenshot({ path: `test-results/viewport/deadline-list-${width}-pass.png`, fullPage: true });
    // This owned record simulates an existing pre-migration row, never shared/production data.
    await db.dealDetails.update({ where: { projectId: id }, data: { submissionDeadlineAt: null, submissionDeadlineZone: null } });
    await page.goto(`/projects/${id}`);
    await page.getByText("Submit by 2026-11-01 (date only)", { exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Edit details", exact: true }).click();
    expect(await dialog.getByLabel("Submission time", { exact: true }).inputValue()).toBe("");
    await dialog.getByLabel("Need", { exact: true }).fill("Unrelated legacy edit");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.reload();
    await page.getByText("Submit by 2026-11-01 (date only)", { exact: true }).waitFor({ state: "visible" });
    expect((await owner.c.get(`/api/projects/${id}`)).json.project.deal.details.submissionDeadlineAt).toBeNull();
    await page.screenshot({ path: `test-results/viewport/deadline-legacy-${width}-pass.png`, fullPage: true });
  } catch (error) {
    await page.screenshot({ path: `test-results/viewport/deadline-${width}-fail.png`, fullPage: true });
    writeFileSync(`test-results/viewport/deadline-${width}-fail.json`, JSON.stringify({ url: page.url(), body: await page.locator("body").innerText() }));
    throw error;
  } finally { await context.close(); }
}, 180000);
