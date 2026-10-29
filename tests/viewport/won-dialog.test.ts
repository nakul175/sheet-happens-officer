// SHO-3050 supersedes the Won refusal; APL-2691 open-task alerts remain for Lost. Vitest's expect, not Playwright's.
// Runs with the phone checks (npm run test:viewport), which has Chromium and a local server.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { admin, BASE, istDate, PW, superAdmin, task, type Account } from "../helpers";

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
let subId = "";

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
  const sub = await make("sub", `Parent ${Date.now()}`);
  subId = sub.id;
  expect((await lead.c.post(`/api/projects/${subId}/tasks`, { title: `Child ${Date.now()}`, parentId: sub.stepId })).status).toBe(201);

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

describe("qa:TC missing APL-2691 Move to Lost dialog", () => {
  it("@APL-2691 qa:TC-APL2691-8d4e9e0b@v1 TC1 AC1: Move to Lost shows an alert with 21, the first 20 tasks, and how many remain", async () => {
    const { dialog, alert } = await openStage(wonId, "Lost");
    const text = await alert.innerText();
    expect(text).toContain("21");
    expect(text).toContain("and 1 more");
    const shown = (await dialog.getByRole("link").allTextContents()).map((t) => t.trim());
    expect(shown).toHaveLength(20);
    expect(wonTitles.filter((t) => !shown.includes(t))).toHaveLength(1);
    await dialog.getByLabel("Reason (required)").fill("ZZ-TEST Lost guard");
    await dialog.getByRole("button", { name: "Move deal" }).click();
    await alert.waitFor({ state: "visible", timeout: WITHIN });
    expect(await alert.innerText()).toContain("21");
    expect(await alert.innerText()).toContain("and 1 more");
    expect(await dealState(wonId)).toEqual({ stage: "Lead", archived: false });
    expect((await lead.c.get(`/api/tasks/${wonTaskIds[0]}`)).json.task.completedAt).toBeNull();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }, 60000);

  it("@APL-2691 qa:TC-APL2691-c3d4c477@v1 TC2 AC2: Move to Lost says 1 open task and lists that task", async () => {
    const { dialog, alert } = await openStage(lostId, "Lost");
    const text = await alert.innerText();
    expect(text).toContain("1 open task");
    expect(text).not.toContain("open tasks");
    expect(text).not.toMatch(/and \d+ more/);
    expect((await dialog.getByRole("link").allTextContents()).map((t) => t.trim())).toEqual([lostStep]);
    await dialog.getByLabel("Reason (required)").fill("ZZ-TEST lost");
    await dialog.getByLabel("Reason (required)").fill("ZZ-TEST Lost guard");
    await dialog.getByRole("button", { name: "Move deal" }).click();
    await alert.waitFor({ state: "visible", timeout: WITHIN });
    expect(await alert.innerText()).toContain("1 open task");
    expect(await dealState(lostId)).toEqual({ stage: "Lead", archived: false });
    expect((await lead.c.get(`/api/tasks/${lostStepId}`)).json.task.completedAt).toBeNull();
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }, 60000);

  it("qa:TC missing @APL-2691 phone: at 390x844 Move deal receives the click, and the tab bar does not take it", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      const { dialog, alert } = await openStage(wonId, "Lost");
      const bar = page.locator(".tabbar-wrap");
      await bar.waitFor({ state: "visible", timeout: WITHIN });
      const move = dialog.getByRole("button", { name: "Move deal" });
      await move.evaluate((el) => el.scrollIntoView({ block: "end", inline: "nearest" }));
      const button = await move.boundingBox();
      const tab = await bar.boundingBox();
      expect(button && tab && button.y < tab.y + tab.height && button.y + button.height > tab.y).toBe(true);
      await dialog.getByLabel("Reason (required)").fill("ZZ-TEST Lost guard");
      await move.click();
      await alert.waitFor({ state: "visible", timeout: WITHIN });
      expect(await alert.innerText()).toContain("21");
      expect(await dealState(wonId)).toEqual({ stage: "Lead", archived: false });
      await dialog.getByRole("button", { name: "Cancel" }).click();
    } finally {
      await page.setViewportSize({ width: 1280, height: 900 });
    }
  }, 60000);

  it("@APL-2691 qa:TC-APL2691-b797e18b@v1 TC4: the dialog points at the alert with aria-describedby and focus moves to it", async () => {
    await page.goto(`/projects/${wonId}`);
    await page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Lost", exact: true }).click();
    await page.waitForFunction(() => {
      const dialog = document.querySelector('[role="dialog"][aria-label="Move to Lost"]');
      const id = dialog?.getAttribute("aria-describedby");
      if (!id || !dialog) return false;
      const alert = document.getElementById(id);
      return !!alert
        && dialog.contains(alert)
        && alert.getAttribute("role") === "alert"
        && document.activeElement === alert
        && (alert.textContent ?? "").includes("21")
        && (alert.textContent ?? "").includes("and 1 more");
    }, undefined, { timeout: WITHIN });
    await page.getByRole("dialog", { name: "Move to Lost" }).getByRole("button", { name: "Cancel" }).click();
  }, 60000);

  it("qa:TC missing @APL-2691 TC5: a second click while the list loads opens one dialog, and a failed load is said in it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pattern = `**/api/projects/${wonId}/tasks**`;
    await page.route(pattern, async (route) => {
      await gate;
      await route.fulfill({ status: 500, contentType: "application/json", body: "{\"error\":\"nope\"}" });
    });
    try {
      await page.goto(`/projects/${wonId}`);
      const won = page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Lost", exact: true });
      await won.waitFor({ state: "visible", timeout: WITHIN });
      await won.click();
      await won.click();
      release();
      const dialog = page.getByRole("dialog", { name: "Move to Lost" });
      await dialog.waitFor({ state: "visible", timeout: WITHIN });
      expect(await page.getByRole("dialog", { name: "Move to Lost" }).count()).toBe(1);
      expect(await dialog.getByRole("alert").innerText()).toContain("Could not load the open tasks.");
      expect(await dialog.getByRole("button", { name: "Move deal" }).isEnabled()).toBe(true);
      await dialog.getByRole("button", { name: "Cancel" }).click();
    } finally {
      release();
      await page.unroute(pattern);
    }
  }, 60000);

  it("qa:TC missing @APL-2691 TC9: the dialog count includes a subtask and matches the refusal", async () => {
    const listed = await lead.c.get(`/api/projects/${subId}/tasks`);
    expect(listed.json.summary.open).toBe(1);
    expect(listed.json.summary.openTasks).toBe(2);
    const { dialog, alert } = await openStage(subId, "Lost");
    const text = await alert.innerText();
    expect(text).toContain("2 open tasks");
    expect(text).toContain("and 1 more");
    const project = (await lead.c.get(`/api/projects/${subId}`)).json.project;
    const won = (project.deal.pipeline.stages as { id: string; name: string }[]).find((s) => s.name === "Lost")!.id;
    const blocked = await lead.c.post(`/api/projects/${subId}/stage`, { stageId: won, reason: "ZZ-TEST Lost guard" });
    expect(blocked.status).toBe(409);
    expect(blocked.json.openTasks).toBe(2);
    expect(text).toContain(`${blocked.json.openTasks} open task`);
    expect(await dealState(subId)).toEqual({ stage: "Lead", archived: false });
    await dialog.getByRole("button", { name: "Cancel" }).click();
  }, 60000);

  it("qa:TC missing @APL-2691 TC7: SHO-3050: moves to Won with 21 open tasks and retains every task unchanged", async () => {
    const snapshots = await Promise.all(wonTaskIds.map(async (id) => (await lead.c.get(`/api/tasks/${id}`)).json.task));
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
    for (let i = 0; i < wonTaskIds.length; i++) expect((await lead.c.get(`/api/tasks/${wonTaskIds[i]}`)).json.task).toEqual(snapshots[i]);
  }, 90000);
});
