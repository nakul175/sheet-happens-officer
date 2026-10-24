// SHO-US-14.3 AC5: axe-core on every screen (WCAG 2 A/AA plus best practice: heading order, landmarks, empty table headers). Same setup as the phone suite. Needs a running app (TASKBOARD_URL) on a TEST database, and a Chromium:
//   locally set PW_CHROMIUM to a chrome binary; in CI run `npx playwright-core install --with-deps chromium` first.
// It signs in as throw-away accounts it creates itself with invented names, and never touches any other database.
// Fails with: screen, width, element, and a screenshot saved under test-results/viewport/.
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { account, BASE, istDate, PW, project, superAdmin, task } from "../helpers";
import { readFileSync } from "node:fs";
import { SCREENS, type Ids } from "./screens";

const SHOTS = "test-results/a11y";
const AXE = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
let browser: Browser;
let ids: Ids;
let viewerEmail = "";

beforeAll(async () => {
  // The suite creates accounts and data, so it only runs against a server on this machine (a test database), never a live site.
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error(`Refusing to run the viewport suite against ${BASE}: use a local server with a test database.`);
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const root = await superAdmin();
  const editor = await account("vpeditor");
  const viewer = await account("vpviewer");
  viewerEmail = viewer.email;
  const p = await project(root, root, [{ who: editor }, { who: viewer, role: "VIEWER" }]);
  const parent = await task(root, p.id, { title: "Prepare the quarterly review pack with the finance team", dueDate: istDate(2), priority: "HIGH", collaboratorIds: [editor.id] });
  await task(root, p.id, { title: "W".repeat(100), sectionId: p.doing, dueDate: istDate(-1) }); // a 100-character unbreakable title
  await root.c.post(`/api/projects/${p.id}/tasks`, { title: "Draft the summary", parentId: parent });
  const org = await root.c.post("/api/orgs", { name: `Viewport Org ${Date.now()}` });
  const orgId = org.json.organisation.id as string;
  const pipes = (await root.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
  const d = await root.c.post("/api/deals", {
    name: `Viewport Deal ${Date.now()}`, organisationId: orgId, pipelineId: pipes.find((x) => x.key === "DEAL_PROACTIVE")!.id, leaderId: root.id,
    whyPursue: "Test deal", nextStep: { title: "Call the buyer", dueDate: istDate(3) },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  ids = { project: p.id, task: parent, deal: (d.json.deal?.id ?? d.json.project?.id) as string, org: orgId };
}, 60000);
afterAll(async () => { await browser?.close(); });


async function ctxFor(who: "root" | "viewer" | null, width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, baseURL: BASE });
  if (who) {
    const r = await ctx.request.post("/api/auth/signin", { data: { email: who === "root" ? "root.test@aplyd.com" : viewerEmail, password: PW } });
    expect(r.ok()).toBe(true);
  }
  return ctx;
}

for (const width of [1280, 390]) {
  describe(`axe at ${width} px`, () => {
    for (const s of SCREENS) {
      it(`${s.name}`, async () => {
        const ctx = await ctxFor(s.public ? null : s.as === "viewer" ? "viewer" : "root", width);
        const page = await ctx.newPage();
        await page.goto(s.path(ids), { waitUntil: "load" });
        await page.waitForFunction(() => !document.querySelector(".skel, .skel-wrap"), undefined, { timeout: 15000 }).catch(() => {});
        if (s.wait) await page.waitForSelector(s.wait, { timeout: 10000 });
        await page.waitForTimeout(400);
        await page.evaluate(AXE);
        const res = await page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const r = await (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] }, rules: { "color-contrast": { enabled: false } } });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return r.violations.map((v: any) => ({ id: v.id, impact: v.impact, nodes: v.nodes.slice(0, 3).map((n: any) => n.target.join(" ") + " :: " + n.failureSummary) }));
        });
        if (res.length) await page.screenshot({ path: `${SHOTS}/${s.name.replace(/[^a-z0-9]+/gi, "-")}-${width}.png`, fullPage: true });
        await ctx.close();
        expect(res, `${s.name} at ${width}px`).toEqual([]);
      });
    }
  });
}

describe("keyboard", () => {
  it("Skip to content is the first Tab stop and moves focus to main", async () => {
    const ctx = await ctxFor("root", 1280);
    const page = await ctx.newPage();
    await page.goto("/projects", { waitUntil: "load" });
    await page.waitForSelector("main#main");
    await page.waitForTimeout(800);
    // Headless Chromium spends the first Tab on the document itself; the next stop must be the skip link.
    await page.keyboard.press("Tab");
    if (await page.evaluate(() => document.activeElement === document.body)) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.className + ":" + document.activeElement?.tagName)).toBe("skip:A");
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");
    await ctx.close();
  });
  it("40 Tabs stay inside the task panel and Escape returns focus to the row", async () => {
    const ctx = await ctxFor("root", 1280);
    const page = await ctx.newPage();
    await page.goto(`/projects/${ids.project}`, { waitUntil: "load" });
    const row = page.locator('[role="link"][tabindex="0"]').first();
    await row.waitFor();
    await row.focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="dialog"]');
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), `Tab ${i + 1}`).toBe(true);
    }
    await page.keyboard.press("Escape");
    await page.waitForSelector('[role="dialog"]', { state: "detached" });
    expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("link");
    await ctx.close();
  });
  it("Retry loads the screen again without a full page reload", async () => {
    const ctx = await ctxFor("root", 1280);
    const page = await ctx.newPage();
    await page.goto("/", { waitUntil: "load" });
    await page.waitForSelector("main#main");
    await page.evaluate(() => { (window as unknown as { __kept: number }).__kept = 1; });
    await page.route("**/api/my-tasks", (r) => r.abort());
    await page.getByRole("link", { name: "Projects" }).first().click();
    await page.getByRole("link", { name: "My tasks" }).first().click();
    await page.getByText("Could not reach the server.").waitFor();
    await page.unroute("**/api/my-tasks");
    await page.getByRole("button", { name: "Retry" }).click();
    await page.getByText("Could not reach the server.").waitFor({ state: "detached" });
    expect(await page.evaluate(() => (window as unknown as { __kept?: number }).__kept)).toBe(1);
    await ctx.close();
  });
  it("shows grey rows only after 400 ms of loading", async () => {
    const ctx = await ctxFor("root", 1280);
    const page = await ctx.newPage();
    await page.goto("/projects", { waitUntil: "load" });
    await page.waitForSelector("main#main");
    await page.route("**/api/my-tasks", async (r) => { await new Promise((x) => setTimeout(x, 1500)); await r.continue(); });
    await page.getByRole("link", { name: "My tasks" }).first().click();
    await page.waitForSelector(".skel-wrap");
    expect(await page.locator(".skel-row").count()).toBe(0);
    await page.waitForSelector(".skel-row", { timeout: 1000 });
    await ctx.close();
  });
});
