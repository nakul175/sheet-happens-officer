// APL-2691: Move to Won must show the open-task alert (role=alert) as soon as the dialog opens.
// Browser coverage for SHO-US-10.3 AC6. Runs with the phone checks (npm run test:viewport) because that job has Chromium and a local server.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { admin, BASE, istDate, PW, superAdmin, task, withVersion, type Account } from "../helpers";

let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let lead: Account;
let dealId = "";
let titles: string[] = [];
let taskIds: string[] = [];

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error(`Refusing to run the Won dialog check against ${BASE}: use a local server with a test database.`);
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const sa = await superAdmin();
  lead = await admin(sa, "wone2e");
  const pipes = (await lead.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string; stages: { id: string; name: string }[] }[];
  const pro = pipes.find((p) => p.key === "DEAL_PROACTIVE")!;
  const orgId = (await lead.c.post("/api/orgs", { name: `Org e2e 2691 ${Date.now()}` })).json.organisation.id as string;
  const step = `Won step ${Date.now()}`;
  const made = await lead.c.post("/api/deals", {
    name: `Deal e2e 2691 ${Date.now()}`, organisationId: orgId, pipelineId: pro.id, leaderId: lead.id, whyPursue: "fit",
    nextStep: { title: step, dueDate: istDate(4) },
  });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  dealId = made.json.deal.id as string;
  const stepId = (await lead.c.get(`/api/projects/${dealId}`)).json.project.deal.nextStep.id as string;
  taskIds = [stepId];
  titles = [step];
  for (let i = 0; i < 20; i++) {
    const title = `Open e2e ${i} ${Date.now()}`;
    taskIds.push(await task(lead, dealId, { title }));
    titles.push(title);
  }
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, baseURL: BASE });
  const signed = await ctx.request.post("/api/auth/signin", { data: { email: lead.email, password: PW } });
  expect(signed.ok(), "sign in for the Won dialog").toBe(true);
  page = await ctx.newPage();
}, 90000);

afterAll(async () => { await ctx?.close(); await browser?.close(); });

async function openStage(name: string) {
  await page.goto(`/projects/${dealId}`);
  const posts: string[] = [];
  const onRequest = (req: { method: () => string; url: () => string }) => {
    const path = new URL(req.url()).pathname;
    if (req.method() === "POST" && path === `/api/projects/${dealId}/stage`) posts.push(path);
  };
  page.on("request", onRequest);
  await page.getByRole("group", { name: "Stage" }).getByRole("button", { name, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Move to ${name}` });
  await expect(dialog).toBeVisible();
  page.off("request", onRequest);
  return { dialog, posts };
}

describe("APL-2691 Move to Won dialog", () => {
  it("shows an alert naming the 21 open tasks, and lists the first 20, before Move", async () => {
    const { dialog, posts } = await openStage("Won");
    const alert = dialog.getByRole("alert");
    await expect(alert).toContainText("21");
    await expect(alert).toContainText("open tasks");
    const shown = (await dialog.getByRole("link").allTextContents()).map((t) => t.trim());
    expect(shown).toHaveLength(20);
    expect(titles.filter((t) => !shown.includes(t))).toHaveLength(1);
    expect(posts, "the alert is the preview, not the result of trying to move").toEqual([]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect((await lead.c.get(`/api/projects/${dealId}`)).json.project.deal.stage.name).toBe("Lead");
    expect((await lead.c.get(`/api/projects/${dealId}`)).json.project.archived).toBe(false);
    expect((await lead.c.get(`/api/tasks/${taskIds[0]}`)).json.task.completedAt).toBeNull();
  }, 60000);

  it("names the open task in Move to Lost before Move is clicked", async () => {
    const { dialog, posts } = await openStage("Lost");
    await expect(dialog.getByRole("alert")).toContainText(titles[0]);
    await expect(dialog.getByRole("link", { name: titles[0] })).toBeVisible();
    expect(posts).toEqual([]);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect((await lead.c.get(`/api/projects/${dealId}`)).json.project.deal.stage.name).toBe("Lead");
  }, 60000);

  it("moves to Won once every task is closed, and does not archive the deal or restamp the tasks", async () => {
    const stamps: string[] = [];
    for (const id of taskIds) {
      expect((await lead.c.post(`/api/tasks/${id}/complete`, await withVersion(lead, id))).status).toBe(200);
      stamps.push((await lead.c.get(`/api/tasks/${id}`)).json.task.completedAt as string);
    }
    const { dialog } = await openStage("Won");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Move deal" }).click();
    await expect(page.getByRole("group", { name: "Stage" }).getByRole("button", { name: "Won", exact: true })).toHaveAttribute("aria-current", "step");
    const after = (await lead.c.get(`/api/projects/${dealId}`)).json.project;
    expect(after.deal.stage.name).toBe("Won");
    expect(after.archived).toBe(false);
    for (let i = 0; i < taskIds.length; i++) expect((await lead.c.get(`/api/tasks/${taskIds[i]}`)).json.task.completedAt).toBe(stamps[i]);
  }, 90000);
});
