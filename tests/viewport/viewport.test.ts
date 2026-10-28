// SHO-US-22.11: phone-size checks on every screen. Needs a running app (TASKBOARD_URL) on a TEST database, and a Chromium:
//   locally set PW_CHROMIUM to a chrome binary; in CI run `npx playwright-core install --with-deps chromium` first.
// It signs in as throw-away accounts it creates itself with invented names, and never touches any other database.
// Fails with: screen, width, element, and a screenshot saved under test-results/viewport/.
import { mkdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { account, BASE, istDate, PW, project, superAdmin, task } from "../helpers";
import { collect, type Finding } from "./checks";
import { PHONE_MAX, SCREENS, WIDTHS, type Ids } from "./screens";

const SHOTS = "test-results/viewport";
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
  const org = await root.c.post("/api/orgs", { force: true, name: `Viewport Org ${Date.now()}` });
  const orgId = org.json.organisation.id as string;
  const pipes = (await root.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
  const d = await root.c.post("/api/deals", {
    force: true,     name: `Viewport Deal ${Date.now()}`, organisationId: orgId, pipelineId: pipes.find((x) => x.key === "DEAL_PROACTIVE")!.id, leaderId: root.id,
    whyPursue: "Test deal", nextStep: { title: "Call the buyer", dueDate: istDate(3) },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  ids = { project: p.id, task: parent, deal: (d.json.deal?.id ?? d.json.project?.id) as string, org: orgId };
}, 60000);
afterAll(async () => { await browser?.close(); });

async function signedIn(width: number, who: "root" | "viewer" | null) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < PHONE_MAX, isMobile: width < PHONE_MAX, baseURL: BASE });
  if (who) {
    const email = who === "root" ? "root.test@aplyd.com" : viewerEmail;
    const r = await ctx.request.post("/api/auth/signin", { data: { email, password: PW } });
    expect(r.ok(), "sign in for the viewport suite").toBe(true);
  }
  return ctx;
}

async function check(ctx: BrowserContext, path: string, width: number, wait?: string) {
  const page = await ctx.newPage();
  try {
    await page.goto(path, { waitUntil: "load" });
    await page.waitForFunction(() => !document.querySelector(".skel, .skel-wrap"), undefined, { timeout: 15000 }).catch(() => {});
    if (wait) await page.waitForSelector(wait, { timeout: 10000 });
    await page.waitForTimeout(400);
    const found: Finding[] = await page.evaluate(collect, width < PHONE_MAX);
    return { page, found };
  } catch (e) { await page.close(); throw e; }
}

for (const width of WIDTHS) {
  describe(`${width} px`, () => {
    const ctxs: Partial<Record<"root" | "viewer" | "none", BrowserContext>> = {};
    afterAll(async () => { for (const c of Object.values(ctxs)) await c?.close(); });
    for (const s of SCREENS) {
      it(`${s.name} @ ${width} px`, async () => {
        const key = s.public ? "none" : s.as ?? "root";
        ctxs[key] ??= await signedIn(width, s.public ? null : key === "viewer" ? "viewer" : "root");
        const { page, found } = await check(ctxs[key]!, s.path(ids), width, s.wait);
        if (found.length) {
          const shot = `${SHOTS}/${s.name.replace(/[^a-z0-9]+/gi, "-")}-${width}.png`;
          await page.screenshot({ path: shot, fullPage: true });
          await page.close();
          const lines = found.slice(0, 12).map((f) => `  ${f.check}: ${f.element} (${f.detail})`).join("\n");
          expect.fail(`${s.name} at ${width} px has ${found.length} problem${found.length === 1 ? "" : "s"}:\n${lines}\n  screenshot: ${shot}`);
        }
        await page.close();
      });
    }
  });
}

// The checks must catch what they claim to catch (SHO-US-22.11 AC2): a 400 px fixed-width element on a 320 px screen.
describe("the checks themselves", () => {
  const html = (body: string, meta = "width=device-width, initial-scale=1, viewport-fit=cover") =>
    `<!doctype html><meta name="viewport" content="${meta}"><body style="margin:0">${body}</body>`;
  async function run(body: string, width: number, meta?: string) {
    const ctx = await browser.newContext({ viewport: { width, height: 700 } });
    const page = await ctx.newPage();
    await page.setContent(html(body, meta));
    const found: Finding[] = await page.evaluate(collect, width < PHONE_MAX);
    await ctx.close();
    return found;
  }
  it("fails a page with 400 px of fixed width and names the element", async () => {
    const f = await run('<div class="board-fault" style="width:400px;height:20px">wide</div>', 320);
    expect(f.some((x) => x.check === "overflow" && x.element.includes("div.board-fault"))).toBe(true);
  });
  it("does not fail a wide table that scrolls inside its own box", async () => {
    expect(await run('<div style="overflow-x:auto"><table style="width:900px"><tr><td>x</td></tr></table></div>', 320)).toEqual([]);
  });
  it("fails a 30 px button, a 14 px field and a missing viewport-fit", async () => {
    const f = await run('<button style="width:30px;height:30px">x</button><input style="font-size:14px;height:44px">', 360, "width=device-width, initial-scale=1");
    expect(f.map((x) => x.check).sort()).toEqual(["field", "meta", "target"]);
  });
});
