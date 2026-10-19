// APL-2736 (SHO-US-10.2 AC3). In a signed-in browser, the Super Admin removes a deal stage: without a choice the
// answer asks which other stage its items go to and the board keeps the column; with a choice the deal moves
// and the column goes. The removed stage is a ZZ-TEST row this file inserts; seeded stages are only asked about.
// Local only, workers=1 (vitest.e2e.config.mts). Run: npm run test:e2e
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { BASE, PW, SUPER_EMAIL, istDate, superAdmin, type Account } from "../tests/helpers";
import { db } from "../src/lib/db";

const RUN = Date.now().toString(36);
const STAGE_ID = `st_zz_2736e2e_${RUN}`;
const STAGE_NAME = `ZZ-TEST stage ${RUN}`;
const DEAL_NAME = `ZZ-TEST Deal 2736 ${RUN}`;

type Pipe = { id: string; key: string; stages: { id: string; name: string }[] };

let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let sa: Account;
let pro: Pipe;
let dealId = "";

const column = (name: string) => page.getByRole("region", { name, exact: true });
const proposalId = () => pro.stages.find((s) => s.name === "Proposal")!.id;

async function board() {
  await page.goto("/deals", { waitUntil: "domcontentloaded", timeout: 120000 });
  await column("Proposal").waitFor({ state: "visible", timeout: 120000 });
}

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) {
    throw new Error(`Refusing to run against ${BASE}: this spec is local only.`);
  }
  sa = await superAdmin();
  pro = ((await sa.c.get("/api/deals/pipelines")).json.pipelines as Pipe[]).find((p) => p.key === "DEAL_PROACTIVE")!;
  await db.stage.create({ data: { id: STAGE_ID, pipelineId: pro.id, name: STAGE_NAME, position: 100, category: "ACTIVE", requiredFields: [] } });
  const org = (await sa.c.post("/api/orgs", { name: `ZZ-TEST Org 2736 ${RUN}` })).json.organisation.id as string;
  const r = await sa.c.post("/api/deals", {
    name: DEAL_NAME, organisationId: org, pipelineId: pro.id, leaderId: sa.id, whyPursue: "fit",
    nextStep: { title: "First call", dueDate: istDate(2) },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  dealId = r.json.deal.id as string;
  await db.project.update({ where: { id: dealId }, data: { stageId: STAGE_ID } });

  browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || "/usr/local/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: BASE });
  const signed = await ctx.request.post("/api/auth/signin", { data: { email: SUPER_EMAIL, password: PW } });
  expect(signed.ok(), "sign in").toBe(true);
  page = await ctx.newPage();
}, 180000);

afterAll(async () => {
  await browser?.close();
  if (await db.stage.findUnique({ where: { id: STAGE_ID } })) {
    await db.project.updateMany({ where: { stageId: STAGE_ID }, data: { stageId: proposalId() } });
    await db.stage.delete({ where: { id: STAGE_ID } });
  }
  if (dealId) await sa?.c.post(`/api/projects/${dealId}/archive`);
});

describe("qa:TC missing APL-2736 removing a stage asks where its items go", () => {
  it("qa:TC missing AC1: removing a seeded stage asks where its items go and keeps the column", async () => {
    const negotiation = pro.stages.find((s) => s.name === "Negotiation")!;
    const r = await ctx.request.delete(`/api/deals/pipelines/${negotiation.id}`);
    const body = await r.text();
    expect(r.status(), body).toBe(409);
    expect(body).toMatch(/where/i);
    expect(body).toMatch(/another stage/i);
    await board();
    await expect.poll(() => column("Negotiation").isVisible()).toBe(true);
  });

  it("qa:TC missing AC1: the stage stays until another stage is chosen, then its deal moves there", async () => {
    await board();
    await column(STAGE_NAME).getByText(DEAL_NAME).waitFor({ state: "visible", timeout: 15000 });

    const asked = await ctx.request.delete(`/api/deals/pipelines/${STAGE_ID}`);
    const body = JSON.parse(await asked.text()) as { error: string; needsMoveTo: boolean; items: number; stages: { name: string }[] };
    expect(asked.status(), JSON.stringify(body)).toBe(409);
    expect(body).toMatchObject({ needsMoveTo: true, items: 1 });
    expect(body.stages.map((s) => s.name)).toContain("Proposal");
    await board();
    await column(STAGE_NAME).getByText(DEAL_NAME).waitFor({ state: "visible", timeout: 15000 });

    const done = await ctx.request.delete(`/api/deals/pipelines/${STAGE_ID}?moveTo=${proposalId()}`);
    expect(done.status(), await done.text()).toBe(200);
    await board();
    await column("Proposal").getByText(DEAL_NAME).waitFor({ state: "visible", timeout: 15000 });
    expect(await column(STAGE_NAME).count()).toBe(0);
  });
});
