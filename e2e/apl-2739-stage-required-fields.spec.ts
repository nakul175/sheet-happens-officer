// APL-2739 (APL-2529 AC3). Moving a deal to Negotiation without a value is refused, the stage dialog asks for
// Value and Currency, and sending them with the move succeeds.
// Local only, workers=1 (vitest.e2e.config.mts). ZZ-TEST deal and organisation, archived afterwards. Run: npm run test:e2e
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { account, BASE, istDate, PW, type Account } from "../tests/helpers";

const SHOTS = "test-results/apl-2739";
const LEAD_EMAIL = "nakul17+zztest-2739-lead@aplyd.com";

let browser: Browser;
let lead: Account;
let dealId = "";
let orgId = "";

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) {
    throw new Error(`Refusing to run against ${BASE}: this spec is local only.`);
  }
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.PW_CHROMIUM || "/usr/local/bin/google-chrome",
    args: ["--no-sandbox"],
  });
  lead = await account("nakul17+zztest-2739-lead", LEAD_EMAIL);
  const pipes = (await lead.c.get("/api/deals/pipelines")).json.pipelines as { key: string; id: string }[];
  const pro = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
  const org = await lead.c.post("/api/orgs", { name: `ZZ-TEST org 2739 ${Date.now()}` });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  orgId = org.json.organisation.id as string;
  const d = await lead.c.post("/api/deals", {
    name: `ZZ-TEST deal 2739 ${Date.now()}`, organisationId: orgId, pipelineId: pro.id, leaderId: lead.id,
    whyPursue: "ZZ-TEST fit", nextStep: { title: "ZZ-TEST step", dueDate: istDate(6) },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  dealId = d.json.deal.id as string;
}, 180000);

afterAll(async () => {
  await browser?.close();
  if (dealId) await lead?.c.post(`/api/projects/${dealId}/archive`);
  if (orgId) await lead?.c.post(`/api/orgs/${orgId}/archive`, { archive: true });
});

describe("qa:TC missing APL-2739 stage dialog asks for required fields", () => {
  it("qa:TC missing AC1: the move is refused, the dialog asks for Value and Currency, and sending them moves the deal", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: BASE });
    try {
      const signed = await ctx.request.post("/api/auth/signin", { data: { email: LEAD_EMAIL, password: PW } });
      expect(signed.ok(), "sign in").toBe(true);
      const page = await ctx.newPage();
      await page.goto(`/projects/${dealId}`, { waitUntil: "domcontentloaded", timeout: 120000 });
      const stage = page.getByRole("group", { name: "Stage" });
      await stage.getByRole("button", { name: "Lead", exact: true }).waitFor({ state: "visible", timeout: 120000 });
      expect(await stage.getByRole("button", { name: "Lead", exact: true }).getAttribute("aria-current")).toBe("step");

      await stage.getByRole("button", { name: "Negotiation", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Move to Negotiation" });
      await dialog.getByLabel("Value (required)").waitFor({ state: "visible", timeout: 15000 });
      await dialog.getByLabel("Currency (required)").waitFor({ state: "visible", timeout: 15000 });

      // Moving without the fields: the server answers 409 needsFields and the dialog says what is missing.
      const refused = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${dealId}/stage`) && r.request().method() === "POST");
      await dialog.getByRole("button", { name: "Move deal" }).click();
      const res = await refused;
      expect(res.status()).toBe(409);
      expect((await res.json()).needsFields).toEqual(["value", "currency"]);
      await dialog.getByRole("alert").waitFor({ state: "visible", timeout: 15000 });
      expect(await dialog.getByRole("alert").textContent()).toContain("Fill in value, currency first.");
      expect((await lead.c.get(`/api/projects/${dealId}`)).json.project.deal.stage.name).toBe("Lead");
      await page.screenshot({ path: `${SHOTS}/refused.png` });

      await dialog.getByLabel("Value (required)").fill("250000");
      await dialog.getByLabel("Currency (required)").selectOption("INR");
      await dialog.getByRole("button", { name: "Move deal" }).click();
      await dialog.waitFor({ state: "detached", timeout: 15000 });
      await page.waitForFunction(() => document.querySelector('[role="group"][aria-label="Stage"] [aria-current="step"]')?.textContent === "Negotiation", null, { timeout: 15000 });
      await page.screenshot({ path: `${SHOTS}/moved.png` });

      const deal = (await lead.c.get(`/api/projects/${dealId}`)).json.project.deal;
      expect(deal.stage.name).toBe("Negotiation");
      expect(deal.details).toMatchObject({ value: 250000, currency: "INR" });
    } finally {
      await ctx.close();
    }
  });
});
