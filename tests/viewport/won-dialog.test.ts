// APL-2691 v1: the Move to Won / Lost dialogs show the open-task alert. Vitest's expect, not Playwright's.
// Runs with the phone checks (npm run test:viewport), which has Chromium and a local server.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { admin, BASE, istDate, PW, superAdmin, task, withVersion, type Account } from "../helpers";

const WITHIN = 10_000;

let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let lead: Account;
let wonId = "";
let wonTitles: string[] = [];
let wonTaskIds: string[] = [];
let lostId = "";
let lostStep = "";
let lostStepId = "";

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error(`Refusing to run the Won dialog check against ${BASE}: use a local server with a test database.`);
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const sa = await superAdmin();
  lead = await admin(sa, "wone2e");
  const pipes = (await lead.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
  const pro = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
  const orgId = (await lead.c.post("/api/orgs", { name: `Org e2e 2691 ${Date.now()}` })).json.organisation.id as string;

  async function make(label: string, step: string) {
    const made = await lead.c.post("/api/deals", {
      name: `Deal e2e 2691 ${label} ${Date.now()}`, organisationId: orgId, pipelineId: pro.id, leaderId: lead.id, whyPursue: "fit",
      nextStep: { title: step, dueDate: istDate(4) },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const id = made.json.deal.id as string;
    const stepId = (await lead.c.get(`/api/projects/${id}`)).json.project.deal.nextStep.id as string;
    return { id, stepId };
  }

  const step = `Won step ${Date.now()}`;
  const won = await make("won", step);
  wonId = won.id;
  wonTaskIds = [won.stepId];
  wonTitles = [step];
  for (let i = 0; i < 20; i++) {
    const title = `Open e2e ${i} ${Date.now()}`;
    wonTaskIds.push(await task(lead, wonId, { title }));
    wonTitles.push(title);
  }
  lostStep = `Lost step ${Date.now()}`;
  const lost = await make("lost", lostStep);
  lostId = lost.id;
  lostStepId = lost.stepId;

  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: BASE });
  const signed = await ctx.request.post("/api/auth/signin", { data: { email: lead.email, password: PW } });
  expect(signed.ok(), "sign in for the Won dialog").toBe(true);
  page = await ctx.newPage();
}, 90000);

afterAll(async () => { await ctx?.close(); await browser?.close(); });

async function openStage(projectId: string, name: string) {
  await page.goto(`/projects/${projectId}`);
  await page.getByRole("group", { name: "Stage" }).getByRole("button", { name, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Move to ${name}` });
  await dialog.waitFor({ state: "visible", timeout: WITHIN });
  const alert = dialog.getByRole("alert");
  await alert.waitFor({ state: "visible", timeout: WITHIN });
  return { dialog, alert };
}

async function dealState(projectId: string) {
  const project = (await lead.c.get(`/api/projects/${projectId}`)).json.project;
  return { stage: project.deal.stage.name as string, archived: project.archived as boolean };
}

describe("APL-2691 Move to Won dialog", () => {
  it("AC1: Move to Won shows an alert with 21 and the first 20 tasks, and changes nothing", async () => {
    const { dialog, alert } = await openStage(wonId, "Won");
    expect(await alert.innerText()).toContain("21");
    const shown = (await dialog.getByRole("link").allTextContents()).map((t) => t.trim());
    expect(shown).toHaveLength(20);
    expect(wonTitles.filter((t) => !shown.includes(t))).toHaveLength(1);
    await dialog.getByRole("button", { name: "Move deal" }).click();
    await alert.waitFor({ state: "visible", timeout: WITHIN });
    expect(await alert.innerText()).toContain("21");
    expect(await dealState(wonId)).toEqual({ stage: "Lead", archived: false });
    expect((await lead.c.get(`/api/tasks/${wonTaskIds[0]}`)).json.task.completedAt).toBeNull();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }, 60000);

  it("AC2: Move to Lost says 1 open task and lists that task", async () => {
    const { dialog, alert } = await openStage(lostId, "Lost");
    const text = await alert.innerText();
    expect(text).toContain("1 open task");
    expect(text).not.toContain("open tasks");
    expect((await dialog.getByRole("link").allTextContents()).map((t) => t.trim())).toEqual([lostStep]);
    await dialog.getByLabel("Reason (required)").fill("ZZ-TEST lost");
    await dialog.getByRole("button", { name: "Move deal" }).click();
    await alert.waitFor({ state: "visible", timeout: WITHIN });
    expect(await alert.innerText()).toContain("1 open task");
    expect(await dealState(lostId)).toEqual({ stage: "Lead", archived: false });
    expect((await lead.c.get(`/api/tasks/${lostStepId}`)).json.task.completedAt).toBeNull();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }, 60000);

  it("moves to Won once every task is closed, and does not archive the deal or restamp the tasks", async () => {
    const stamps: string[] = [];
    for (const id of wonTaskIds) {
      expect((await lead.c.post(`/api/tasks/${id}/complete`, await withVersion(lead, id))).status).toBe(200);
      stamps.push((await lead.c.get(`/api/tasks/${id}`)).json.task.completedAt as string);
    }
    await page.goto(`/projects/${wonId}`);
    await page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Won", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Move to Won" });
    await dialog.waitFor({ state: "visible", timeout: WITHIN });
    expect(await dialog.getByRole("alert").count()).toBe(0);
    await dialog.getByRole("button", { name: "Move deal" }).click();
    await page.waitForFunction(() => {
      const won = [...document.querySelectorAll('[aria-label="Stage"] button')].find((b) => b.textContent?.trim() === "Won");
      return won?.getAttribute("aria-current") === "step";
    }, undefined, { timeout: WITHIN });
    expect(await dealState(wonId)).toEqual({ stage: "Won", archived: false });
    for (let i = 0; i < wonTaskIds.length; i++) expect((await lead.c.get(`/api/tasks/${wonTaskIds[i]}`)).json.task.completedAt).toBe(stamps[i]);
  }, 90000);
});
