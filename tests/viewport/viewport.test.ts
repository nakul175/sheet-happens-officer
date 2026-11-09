// SHO-US-22.11: phone-size checks on every screen. Needs a running app (TASKBOARD_URL) on a TEST database, and a Chromium:
//   locally set PW_CHROMIUM to a chrome binary; in CI run `npx playwright-core install --with-deps chromium` first.
// It signs in as throw-away accounts it creates itself with invented names, and never touches any other database.
// Fails with: screen, width, element, and a screenshot saved under test-results/viewport/.
import { mkdirSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { account, BASE, cleanupZz, istDate, PW, project, superAdmin, task, type Account } from "../helpers";
import { collect, type Finding } from "./checks";
import { PHONE_MAX, SCREENS, TASK_TITLE, WIDTHS, type Ids, type Screen } from "./screens";
import { openScreen, requireLocalFixtures } from "./screen-ready";
import { finishViewportFixture } from "./teardown";

const SHOTS = "test-results/viewport";
let browser: Browser;
let ids: Ids;
let viewerEmail = "";
const ownedProjects: string[] = [], ownedPeople: Account[] = [];
let ownedOrganisation = "";
const interactiveWidths: number[] = [];

beforeAll(async () => {
  // The suite creates accounts and data, so it only runs against a server on this machine (a test database), never a live site.
  requireLocalFixtures(BASE, process.env.DATABASE_URL);
  mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const root = await superAdmin();
  const editor = await account("vpeditor");
  ownedPeople.push(editor);
  const viewer = await account("vpviewer");
  ownedPeople.push(viewer);
  viewerEmail = viewer.email;
  const p = await project(root, root, [{ who: editor }, { who: viewer, role: "VIEWER" }]);
  ownedProjects.push(p.id);
  const parent = await task(root, p.id, { title: TASK_TITLE, dueDate: istDate(2), priority: "HIGH", collaboratorIds: [editor.id] });
  await task(root, p.id, { title: "W".repeat(100), sectionId: p.doing, dueDate: istDate(-1) }); // a 100-character unbreakable title
  await root.c.post(`/api/projects/${p.id}/tasks`, { title: "Draft the summary", parentId: parent });
  const org = await root.c.post("/api/orgs", { name: `Viewport Org ${Date.now()}` });
  const orgId = org.json.organisation.id as string;
  ownedOrganisation = orgId;
  const pipes = (await root.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
  const d = await root.c.post("/api/deals", {
    name: `Viewport Deal ${Date.now()}`, organisationId: orgId, pipelineId: pipes.find((x) => x.key === "DEAL_PROACTIVE")!.id, leaderId: root.id,
    whyPursue: "Test deal", nextStep: { title: "Call the buyer", dueDate: istDate(3) },
  });
  expect(d.status, JSON.stringify(d.json)).toBe(201);
  ownedProjects.push((d.json.deal?.id ?? d.json.project?.id) as string);
  ids = { project: p.id, task: parent, deal: (d.json.deal?.id ?? d.json.project?.id) as string, org: orgId, person: editor.id, personName: editor.name };
}, 60000);
afterAll(async () => {
  await finishViewportFixture(
    { projects: ownedProjects.length, people: ownedPeople.length, organisation: Boolean(ownedOrganisation) },
    {
      closeBrowser: async () => { await browser?.close(); },
      cleanupProjectsAndPeople: async () => { if (ownedProjects.length || ownedPeople.length) await cleanupZz(ownedProjects, ownedPeople); },
      archiveOrganisation: async () => {
        if (ownedOrganisation) {
          const root = await superAdmin();
          expect((await root.c.post(`/api/orgs/${ownedOrganisation}/archive`, { archive: true })).status).toBe(200);
        }
      },
      record: (receipt) => {
        mkdirSync(SHOTS, { recursive: true });
        writeFileSync(`${SHOTS}/cleanup.json`, JSON.stringify({ ...receipt, interactiveWidths }, null, 2));
      },
    },
  );
});

async function signedIn(width: number, who: "root" | "viewer" | null) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < PHONE_MAX, isMobile: width < PHONE_MAX, baseURL: BASE });
  if (who) {
    const email = who === "root" ? "root.test@aplyd.com" : viewerEmail;
    const r = await ctx.request.post("/api/auth/signin", { data: { email, password: PW } });
    expect(r.ok(), "sign in for the viewport suite").toBe(true);
  }
  return ctx;
}

async function check(ctx: BrowserContext, screen: Screen, width: number) {
  const path = screen.path(ids);
  const page = await ctx.newPage();
  try {
    await openScreen(page, screen, ids, BASE);
    await page.waitForTimeout(400);
    // SHO-2559 AC2: this test-only switch deliberately breaks one real public route.
    // beforeAll refuses every remote target before any fixture is created.
    if (process.env.SHO_VIEWPORT_NEGATIVE_CONTROL === "1" && path === "/signin" && width === 320) {
      const geometry = await page.evaluate(() => {
        const fault = document.createElement("div");
        fault.id = "sho-2559-negative-control";
        fault.style.cssText = "width:400px;height:20px";
        fault.textContent = "Deliberate 400px viewport regression";
        document.body.append(fault);
        const rect = fault.getBoundingClientRect();
        return { innerWidth: window.innerWidth, documentClientWidth: document.documentElement.clientWidth, bodyScrollWidth: document.body.scrollWidth, faultWidth: rect.width, faultRight: rect.right };
      });
      console.log("SHO-2559 injected geometry:", JSON.stringify({ requestedWidth: width, ...geometry }));
      expect(geometry.faultWidth, "the negative-control fault must actually be 400px wide").toBe(400);
    }
    const found: Finding[] = await page.evaluate(collect, { phone: width < PHONE_MAX, width });
    return { page, found };
  } catch (e) {
    const shot = `${SHOTS}/${path.replace(/[^a-z0-9]+/gi, "-")}-${width}-load-error.png`;
    let evidence = `screenshot: ${shot}`;
    try { await page.screenshot({ path: shot, fullPage: true }); }
    catch (shotError) { evidence = `screenshot unavailable: ${String(shotError)}`; }
    await page.close();
    throw new Error(`${path} at ${width} px did not finish loading; ${evidence}\n${String(e)}`);
  }
}

for (const width of WIDTHS) {
  describe(`${width} px`, () => {
    const ctxs: Partial<Record<"root" | "viewer" | "none", BrowserContext>> = {};
    afterAll(async () => { for (const c of Object.values(ctxs)) await c?.close(); });
    for (const s of SCREENS) {
      it(`${s.name} @ ${width} px`, async () => {
        const key = s.public ? "none" : s.as ?? "root";
        ctxs[key] ??= await signedIn(width, s.public ? null : key === "viewer" ? "viewer" : "root");
        const { page, found } = await check(ctxs[key]!, s, width);
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

it("keeps the Home → Project → Task → Deals → Team → Profile phone journey usable", async () => {
  const width = 390;
  const ctx = await signedIn(width, "root");
  const page = await ctx.newPage();
  const checked: string[] = [];
  async function usable(label: string) {
    await page.waitForTimeout(100);
    const found: Finding[] = await page.evaluate(collect, { phone: true, width });
    if (found.length) {
      const shot = `${SHOTS}/core-journey-${label}.png`;
      await page.screenshot({ path: shot, fullPage: true });
      expect.fail(`${label} has ${found.length} phone-layout problem(s): ${JSON.stringify(found.slice(0, 12))}; screenshot: ${shot}`);
    }
    checked.push(label);
  }
  try {
    await page.goto("/");
    await page.getByRole("heading", { name: "Your workspace" }).waitFor();
    await usable("home");

    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Projects" }).click();
    await page.waitForURL("**/projects");
    await page.locator(`a.pcard[href="/projects/${ids.project}"]`).click();
    await page.waitForURL(`**/projects/${ids.project}`);
    const taskRow = page.locator(".item.click").filter({ hasText: TASK_TITLE }).first();
    await taskRow.waitFor();
    await usable("project");

    await taskRow.click();
    const taskDialog = page.getByRole("dialog", { name: "Task", exact: true });
    await taskDialog.waitFor();
    expect(await taskDialog.getByRole("textbox", { name: "Title", exact: true }).inputValue()).toBe(TASK_TITLE);
    await taskDialog.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await usable("task-overlay-scrolled");
    await page.keyboard.press("Escape");
    await taskDialog.waitFor({ state: "detached" });

    const more = page.getByRole("button", { name: "More", exact: true });
    await more.click();
    await page.getByRole("menuitem", { name: "Deals", exact: true }).click();
    await page.waitForURL("**/deals");
    await usable("deals");

    await more.click();
    await page.getByRole("menuitem", { name: "Team", exact: true }).click();
    await page.waitForURL("**/team");
    await usable("team");

    await more.click();
    await page.getByRole("menuitem", { name: "Profile", exact: true }).click();
    await page.waitForURL("**/profile");
    await usable("profile");
    expect(checked).toEqual(["home", "project", "task-overlay-scrolled", "deals", "team", "profile"]);
  } finally {
    await ctx.close();
  }
});

// The screen scan above sees only the resting page. Exercise the task form at
// each supported width, including its validation state and modal controls.
for (const width of WIDTHS) {
  it(`New task form stays usable and cancels without a write @ ${width} px`, async () => {
    const ctx = await signedIn(width, "root");
    const page = await ctx.newPage();
    let writes = 0;
    try {
      await page.route("**/api/projects/*/tasks", async (route) => {
        if (route.request().method() === "POST") writes++;
        await route.continue();
      });
      await page.goto("/");
      await page.getByRole("heading", { name: "Your workspace" }).waitFor();
      await page.locator("#main").getByRole("button", { name: "+ New task" }).click();
      const dialog = page.getByRole("dialog", { name: "New task" });
      await dialog.waitFor({ state: "visible" });
      await dialog.getByLabel("Title").fill("Viewport form check");
      await dialog.getByLabel("Due date").fill("not a date");
      expect(await dialog.getByLabel("Due date").getAttribute("aria-invalid")).toBe("true");
      expect(await dialog.getByRole("button", { name: "Add task" }).isEnabled()).toBe(false);
      await dialog.getByLabel("Due date").fill("tomorrow");
      expect(await dialog.getByLabel("Due date").getAttribute("aria-invalid")).toBe("false");
      expect(await dialog.getByRole("button", { name: "Add task" }).isEnabled()).toBe(true);
      const found: Finding[] = await page.evaluate(collect, { phone: width < PHONE_MAX, width });
      if (found.length) {
        const shot = `${SHOTS}/new-task-form-${width}.png`;
        await page.screenshot({ path: shot, fullPage: true });
        expect.fail(`New task form at ${width} px has ${found.length} problem(s): ${JSON.stringify(found.slice(0, 12))}; screenshot: ${shot}`);
      }
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await dialog.waitFor({ state: "detached" });
      expect(writes).toBe(0);
      interactiveWidths.push(width);
    } finally {
      await ctx.close();
    }
  });
}

it("New deal buyer mismatch identifies its field and clears on edit @ 390 px", async () => {
  const ctx = await signedIn(390, "root");
  const page = await ctx.newPage();
  let writes = 0;
  try {
    await page.route("**/api/deals", async (route) => {
      if (route.request().method() === "POST") writes++;
      await route.continue();
    });
    await page.route("**/api/orgs", async (route) => {
      if (route.request().method() === "POST") writes++;
      await route.continue();
    });
    await page.goto("/deals/new");
    await page.getByRole("heading", { name: "New deal" }).waitFor();
    await page.getByLabel("Deal name").fill("Buyer error accessibility check");
    await page.getByLabel("Pipeline").selectOption({ label: "Proactive" });
    const buyer = page.getByLabel("Client / Buyer");
    await buyer.fill(`ZZ-MISSING-BUYER-${Date.now()}`);
    await page.getByLabel("Why are we pursuing this?").fill("Check field error association");
    await page.getByLabel("First next step").fill("Review buyer");
    await page.getByRole("button", { name: "Create deal", exact: true }).click();
    const alert = page.locator("#new-deal-buyer-error");
    await alert.waitFor();
    expect(await alert.getAttribute("role")).toBe("alert");
    expect(await alert.textContent()).toMatch(/No existing organisation exactly matches/);
    expect(await buyer.getAttribute("aria-invalid")).toBe("true");
    expect(await buyer.getAttribute("aria-describedby")).toBe("new-deal-buyer-error");
    expect(await alert.getAttribute("id")).toBe("new-deal-buyer-error");
    const found: Finding[] = await page.evaluate(collect, { phone: true, width: 390 });
    expect(found).toEqual([]);
    await buyer.fill("Edited buyer name");
    await alert.waitFor({ state: "detached" });
    expect(await buyer.getAttribute("aria-invalid")).toBe("false");
    expect(await buyer.getAttribute("aria-describedby")).toBe(null);
    expect(writes).toBe(0);
  } finally {
    await ctx.close();
  }
});

it("New deal ignores an obsolete buyer lookup after the field changes @ 390 px", async () => {
  const ctx = await signedIn(390, "root");
  const page = await ctx.newPage();
  let releaseLookup = () => {};
  let lookupStarted = () => {};
  const heldLookup = new Promise<void>((resolve) => { releaseLookup = resolve; });
  const intercepted = new Promise<void>((resolve) => { lookupStarted = resolve; });
  let writes = 0;
  try {
    await page.route("**/api/deals", async (route) => {
      if (route.request().method() === "POST") writes++;
      await route.continue();
    });
    await page.goto("/deals/new");
    await page.getByLabel("Pipeline").selectOption({ label: "Proactive" });
    await page.getByLabel("Deal name").fill("Obsolete buyer lookup check");
    const buyer = page.getByLabel("Client / Buyer");
    await buyer.fill(`ZZ-OLD-BUYER-${Date.now()}`);
    await page.getByLabel("Why are we pursuing this?").fill("Check stale lookup");
    await page.getByLabel("First next step").fill("Review buyer");
    await page.route(/\/api\/orgs\?q=/, async (route) => {
      lookupStarted();
      await heldLookup;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ organisations: [] }) });
    });
    await page.getByRole("button", { name: "Create deal", exact: true }).click();
    await intercepted;
    await buyer.fill("Edited while lookup pending");
    releaseLookup();
    await expect.poll(async () => page.getByRole("button", { name: "Create deal", exact: true }).isEnabled()).toBe(true);
    expect(await page.locator("#new-deal-buyer-error").count(), JSON.stringify(await page.getByRole("alert").allTextContents())).toBe(0);
    expect(await buyer.getAttribute("aria-invalid")).toBe("false");
    expect(writes).toBe(0);
  } finally {
    releaseLookup();
    await ctx.close();
  }
});

// The checks must catch what they claim to catch (SHO-US-22.11 AC2): a 400 px fixed-width element on a 320 px screen.
describe("the checks themselves", () => {
  const html = (body: string, meta = "width=device-width, initial-scale=1, viewport-fit=cover") =>
    `<!doctype html><meta name="viewport" content="${meta}"><body style="margin:0">${body}</body>`;
  async function run(body: string, width: number, meta?: string, mobile = false) {
    const ctx = await browser.newContext({ viewport: { width, height: 700 }, isMobile: mobile });
    const page = await ctx.newPage();
    await page.setContent(html(body, meta));
    const found: Finding[] = await page.evaluate(collect, { phone: width < PHONE_MAX, width });
    await ctx.close();
    return found;
  }
  it("fails a page with 400 px of fixed width and names the element", async () => {
    const f = await run('<div class="board-fault" style="width:400px;height:20px">wide</div>', 320);
    expect(f.some((x) => x.check === "overflow" && x.element.includes("div.board-fault"))).toBe(true);
  });
  it("catches fixed width when mobile layout expands innerWidth to fit the fault", async () => {
    const f = await run('<div id="mobile-fixed-width" style="width:400px;height:20px">wide</div>', 320, undefined, true);
    expect(f.some(x => x.check === "overflow" && x.element.includes("div#mobile-fixed-width") && x.detail.includes("screen is 320 px"))).toBe(true);
  });
  it("does not fail a wide table that scrolls inside its own box", async () => {
    expect(await run('<div style="overflow-x:auto"><table style="width:900px"><tr><td>x</td></tr></table></div>', 320)).toEqual([]);
  });
  it("fails a 30 px button, a 14 px field and a missing viewport-fit", async () => {
    const f = await run('<button style="width:30px;height:30px">x</button><input style="font-size:14px;height:44px">', 360, "width=device-width, initial-scale=1");
    expect(f.map((x) => x.check).sort()).toEqual(["field", "meta", "target"]);
  });
});
