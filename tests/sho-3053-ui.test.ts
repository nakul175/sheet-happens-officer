// Browser acceptance against the same live app as the API suite. No mocked conversion responses.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { account, BASE, cleanupZz, istDate, type Account } from "./helpers";
let browser: Browser, leader: Account, viewer: Account, target: string, pipeline: string, configuredStage: string;
const projects: string[] = [], organisations: string[] = [];
const output = process.env.SHO_3053_ARTIFACT_DIR ?? "test-results/sho-3053";
beforeAll(async () => {
  leader = await account("zz3053ui", undefined, "ZZ-TEST SHO-3053 UI leader"); viewer = await account("zz3053uiviewer", undefined, "ZZ-TEST SHO-3053 UI viewer");
  const r = await leader.c.get("/api/deals/pipelines"); expect(r.status).toBe(200);
  pipeline = r.json.pipelines.find((p: { key: string }) => p.key === "DEAL_PROACTIVE").id;
  const bid = r.json.pipelines.find((p: { key: string }) => p.key === "DEAL_BID"); target = bid.stages[0].id;
  configuredStage = `zz-test-3053-ui-${Date.now()}`;
  await db.stage.create({ data: { id: configuredStage, pipelineId: bid.id, name: "ZZ-TEST Bid required fields", position: 99, category: "ACTIVE", needsReason: true, requiredFields: ["need", "probability"] } });
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, headless: true }); mkdirSync(output, { recursive: true });
});
afterAll(async () => {
  await browser?.close();
  for (const id of organisations) expect((await leader.c.post(`/api/orgs/${id}/archive`, { archive: true })).status).toBe(200);
  await cleanupZz(projects, [leader, viewer]);
  await db.project.updateMany({ where: { id: { in: projects }, stageId: configuredStage }, data: { stageId: target } });
  await db.stage.delete({ where: { id: configuredStage } }); await db.$disconnect();
}, 120_000);
async function fixture(label: string) {
  const name = `ZZ-TEST SHO-3053 UI ${label} ${Date.now()}`;
  const org = await leader.c.post("/api/orgs", { name: `${name} Buyer` }); expect(org.status).toBe(201); organisations.push(org.json.organisation.id);
  const r = await leader.c.post("/api/deals", { name, organisationId: org.json.organisation.id, pipelineId: pipeline, leaderId: leader.id, whyPursue: "ZZ-TEST explicit Bid conversion", value: 5000, currency: "USD", nextStep: { title: "ZZ-TEST retain UI task", dueDate: istDate(4) } }); expect(r.status).toBe(201);
  const id = r.json.deal.id as string; projects.push(id);
  expect((await leader.c.post(`/api/projects/${id}/members`, { userId: viewer.id, role: "VIEWER" })).status).toBe(201);
  return id;
}
async function pageFor(a: Account, width: number, id: string) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const i = a.c.cookie.indexOf("="); await context.addCookies([{ name: a.c.cookie.slice(0, i), value: a.c.cookie.slice(i + 1), url: BASE }]);
  const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/projects/${id}`); await page.getByRole("heading", { name: /ZZ-TEST SHO-3053 UI/ }).waitFor();
  return { context, page, errors };
}
async function sameDeal(id: string) { return JSON.parse(JSON.stringify(await db.project.findUniqueOrThrow({ where: { id }, include: { deal: true, actionLogs: true } }))); }
async function open(page: Page) { await page.getByRole("button", { name: "Convert to Bid", exact: true }).click(); await page.getByLabel("Bid stage (required)").waitFor(); }
async function review(page: Page, stage = target) {
  await page.getByLabel("Bid stage (required)").selectOption(stage); await page.getByLabel("Submission deadline (required)").fill(istDate(20));
  if (stage === configuredStage) { await page.getByLabel("Need (required)").fill("ZZ-TEST requested scope"); await page.getByLabel("Probability % (required)").fill("0"); await page.getByLabel("Reason (required)").fill("ZZ-TEST chosen Bid stage"); }
  await page.getByRole("button", { name: "Review conversion", exact: true }).click(); await page.getByRole("heading", { name: "Review conversion", exact: true }).waitFor();
}

describe("SHO-3053 desktop and phone conversion", () => {
  for (const width of [1280, 390]) {
    it(`${width}px requires explicit choice, reviews required facts, cancels without changes and commits in place`, async () => {
      const id = await fixture(`review ${width}`), { page, context, errors } = await pageFor(leader, width, id);
      try {
        const before = await sameDeal(id); await open(page);
        expect(await page.getByLabel("Bid stage (required)").inputValue()).toBe(""); expect(await page.getByRole("button", { name: "Review conversion", exact: true }).isEnabled()).toBe(false);
        expect(await page.getByLabel("Bid stage (required)").locator("option").allTextContents()).not.toContain("Won");
        await review(page, configuredStage); expect(await page.getByRole("dialog").innerText()).toContain("cannot be undone");
        expect(await page.getByRole("dialog").innerText()).toContain("Proactive / Lead"); expect(await page.getByRole("dialog").innerText()).toContain("Bid / ZZ-TEST Bid required fields");
        const size = await page.getByRole("dialog").boundingBox(); expect(size!.width).toBeLessThanOrEqual(width);
        await page.screenshot({ path: path.join(output, `review-${width}.png`), fullPage: true });
        await page.getByRole("button", { name: "Cancel", exact: true }).click(); expect(await sameDeal(id)).toEqual(before);
        await open(page); await review(page, configuredStage); await page.getByRole("button", { name: "Confirm conversion", exact: true }).click(); await page.getByRole("dialog").waitFor({ state: "hidden" });
        expect(new URL(page.url()).pathname).toBe(`/projects/${id}`); expect(await page.getByRole("button", { name: "Convert to Bid", exact: true }).count()).toBe(0);
        const after = await sameDeal(id); expect(after.deal.value).toBe(before.deal.value); expect(after.deal.probability).toBe(0); expect(after.stageId).toBe(configuredStage);
        await page.screenshot({ path: path.join(output, `converted-${width}.png`), fullPage: true }); expect(errors).toEqual([]);
      } finally { await context.close(); }
    });
    it(`${width}px handles stale confirmation without mutation and with a clear reopen instruction`, async () => {
      const id = await fixture(`stale ${width}`), { page, context, errors } = await pageFor(leader, width, id);
      try {
        await open(page); await review(page);
        expect((await leader.c.patch(`/api/projects/${id}/deal`, { need: "ZZ-TEST changed while reviewing" })).status).toBe(200); const before = await sameDeal(id);
        await page.getByRole("button", { name: "Confirm conversion", exact: true }).click(); await page.getByRole("alert").filter({ hasText: "Close and reopen" }).waitFor();
        expect(await page.getByRole("button", { name: "Review conversion", exact: true }).isEnabled()).toBe(false); expect(await sameDeal(id)).toEqual(before);
        await page.screenshot({ path: path.join(output, `stale-${width}.png`), fullPage: true }); expect(errors).toEqual([]);
      } finally { await context.close(); }
    });
    it(`${width}px hides conversion for Viewers`, async () => {
      const id = await fixture(`viewer ${width}`), { page, context, errors } = await pageFor(viewer, width, id);
      try { expect(await page.getByRole("button", { name: "Convert to Bid", exact: true }).count()).toBe(0); expect(errors).toEqual([]); }
      finally { await context.close(); }
    });
  }
});
