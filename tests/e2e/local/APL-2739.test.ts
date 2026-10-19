// APL-2739 story spec (APL-2529 AC3): Negotiation lists value and currency as required fields.
// An Editor's move without them is refused (409, needsFields), the stage dialog asks for them, and sending them moves the deal.
// workers=1: the cases in this file run one after another, and the suite runs one file at a time.
// Local servers only: the target host must be localhost or 127.0.0.1, so staging and production are refused.
// Thrown-away people, the organisation and the deal use ZZ-TEST names and nakul17+ aliases, then afterAll archives
// the deal and organisation and deactivates the people. Self-signup only accepts @aplyd.com, so the alias is
// nakul17+…@aplyd.com.
import { existsSync, mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { account, BASE, istDate, PW, superAdmin, type Account } from "../../helpers";

const host = new URL(BASE).hostname;
if (host !== "localhost" && host !== "127.0.0.1") throw new Error(`Refusing to run against ${host}: this story spec is local only.`);

const SHOTS = "test-results/APL-2739";
const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
let seq = 0;
const people: Account[] = [];

function chromePath() {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("No Chrome/Chromium binary. Set PW_CHROMIUM.");
}

/** A throwaway person. The display name starts with ZZ-TEST; the address is a run-unique nakul17+ alias. */
async function zzAccount(role: string) {
  const n = seq++;
  const email = `nakul17+zz-2739-${RUN}-${role}-${n}@aplyd.com`;
  const who = await account(`ZZ-TEST ${role} ${RUN}-${n}`, email);
  people.push(who);
  return who;
}

describe("qa:TC missing APL-2739 a stage that lists empty required fields refuses the move until they are sent", () => {
  let browser: Browser;
  let lead: Account;
  let editor: Account;
  let dealId = "";
  let orgId = "";

  beforeAll(async () => {
    mkdirSync(SHOTS, { recursive: true });
    browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
    lead = await zzAccount("lead");
    editor = await zzAccount("editor");
    const pipes = (await lead.c.get("/api/deals/pipelines")).json.pipelines as { key: string; id: string }[];
    const pro = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
    const org = await lead.c.post("/api/orgs", { name: `ZZ-TEST org 2739 ${RUN}` });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    orgId = org.json.organisation.id as string;
    const d = await lead.c.post("/api/deals", {
      name: `ZZ-TEST deal 2739 ${RUN}`, organisationId: orgId, pipelineId: pro.id, leaderId: lead.id,
      whyPursue: "ZZ-TEST fit", nextStep: { title: `ZZ-TEST step ${RUN}`, dueDate: istDate(6) },
    });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    dealId = d.json.deal.id as string;
    expect((await lead.c.post(`/api/projects/${dealId}/members`, { userId: editor.id, role: "EDITOR" })).status).toBe(201);
  }, 180000);

  afterAll(async () => {
    await browser?.close();
    const problems: string[] = [];
    const sa = await superAdmin();
    if (dealId) {
      // The Super Admin takes over as Leader first, so the ZZ-TEST lead can be deactivated afterwards.
      const added = await sa.c.post(`/api/projects/${dealId}/members`, { userId: sa.id, role: "EDITOR" });
      if (added.status !== 201 && !(added.status === 409 && /already a member/.test(added.json?.error ?? ""))) {
        problems.push(`add member: ${added.status} ${JSON.stringify(added.json)}`);
      }
      const led = await sa.c.post(`/api/projects/${dealId}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" });
      if (led.status !== 200 && !(led.status === 400 && /already the Leader/.test(led.json?.error ?? ""))) {
        problems.push(`change leader: ${led.status} ${JSON.stringify(led.json)}`);
      }
      const archived = await sa.c.post(`/api/projects/${dealId}/archive`);
      if (archived.status !== 200) problems.push(`archive deal: ${archived.status} ${JSON.stringify(archived.json)}`);
    }
    if (orgId) {
      const archived = await lead.c.post(`/api/orgs/${orgId}/archive`, { archive: true });
      if (archived.status !== 200) problems.push(`archive org: ${archived.status} ${JSON.stringify(archived.json)}`);
    }
    for (const who of people) {
      const off = await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
      if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.json?.error ?? ""))) {
        problems.push(`deactivate ${who.email}: ${off.status} ${JSON.stringify(off.json)}`);
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("qa:TC missing AC1: an Editor's move is refused (409, needsFields), the dialog asks for Value and Currency, and sending them moves the deal", async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, baseURL: BASE });
    try {
      const signed = await ctx.request.post("/api/auth/signin", { data: { email: editor.email, password: PW } });
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
  }, 180000);
});
