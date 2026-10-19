// APL-2736 story spec (SHO-US-10.2 AC3, parent APL-2528). No qa:TC id was given, so each title says qa:TC missing.
// In a signed-in browser, the Super Admin removes a deal stage: without a choice the answer asks which other stage
// its items go to and the board keeps the column; with a choice the deal moves and the column goes.
// The removed stage is a ZZ-TEST row this file inserts; seeded stages are only asked about.
// Local servers only: anything but localhost or 127.0.0.1 is refused before a test runs.
// The suite runs one file at a time, and the cases in this file run one after another.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { BASE, PW, SUPER_EMAIL, istDate, superAdmin, type Account } from "../../helpers";
import { db } from "../../../src/lib/db";

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
let orgId = "";

const column = (name: string) => page.getByRole("region", { name, exact: true });
const proposalId = () => pro.stages.find((s) => s.name === "Proposal")!.id;

async function board() {
  await page.goto("/deals", { waitUntil: "domcontentloaded", timeout: 120000 });
  await column("Proposal").waitFor({ state: "visible", timeout: 120000 });
}

function chromePath() {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("No Chrome/Chromium binary. Set PW_CHROMIUM.");
}

if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) {
  throw new Error(`Refusing to run against ${BASE}: this spec is local only.`);
}

beforeAll(async () => {
  sa = await superAdmin();
  pro = ((await sa.c.get("/api/deals/pipelines")).json.pipelines as Pipe[]).find((p) => p.key === "DEAL_PROACTIVE")!;
  // The one direct write: the product has no API that creates a stage (stages are migration-only), so the ZZ-TEST
  // stage is inserted here. It is removed through DELETE /api/deals/pipelines/:id in afterAll.
  await db.stage.create({ data: { id: STAGE_ID, pipelineId: pro.id, name: STAGE_NAME, position: 100, category: "ACTIVE", requiredFields: [] } });
  const org = (await sa.c.post("/api/orgs", { name: `ZZ-TEST Org 2736 ${RUN}` })).json.organisation.id as string;
  orgId = org;
  const r = await sa.c.post("/api/deals", {
    name: DEAL_NAME, organisationId: org, pipelineId: pro.id, leaderId: sa.id, whyPursue: "fit",
    nextStep: { title: "First call", dueDate: istDate(2) },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  dealId = r.json.deal.id as string;
  const moved = await sa.c.post(`/api/projects/${dealId}/stage`, { stageId: STAGE_ID });
  expect(moved.status, JSON.stringify(moved.json)).toBe(200);

  browser = await chromium.launch({
    executablePath: chromePath(),
    args: ["--no-sandbox"],
  });
  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: BASE });
  const signed = await ctx.request.post("/api/auth/signin", { data: { email: SUPER_EMAIL, password: PW } });
  expect(signed.ok(), "sign in").toBe(true);
  page = await ctx.newPage();
}, 180000);

// Cleanup goes through the API: the ZZ-TEST stage (if a test left it) is removed by the endpoint under test,
// then the ZZ-TEST deal and organisation are archived.
afterAll(async () => {
  await browser?.close();
  if (!sa) return;
  const problems: string[] = [];
  const pipes = (await sa.c.get("/api/deals/pipelines")).json.pipelines as Pipe[];
  if (pipes.flatMap((p) => p.stages).some((s) => s.id === STAGE_ID)) {
    const r = await sa.c.del(`/api/deals/pipelines/${STAGE_ID}?moveTo=${proposalId()}`);
    if (r.status !== 200) problems.push(`remove stage: ${r.status} ${JSON.stringify(r.json)}`);
  }
  if (dealId) {
    const r = await sa.c.post(`/api/projects/${dealId}/archive`);
    if (r.status !== 200) problems.push(`archive deal: ${r.status} ${JSON.stringify(r.json)}`);
  }
  if (orgId) {
    const r = await sa.c.post(`/api/orgs/${orgId}/archive`, { archive: true });
    if (r.status !== 200) problems.push(`archive org: ${r.status} ${JSON.stringify(r.json)}`);
  }
  expect(problems, problems.join("\n")).toEqual([]);
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
