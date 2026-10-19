// APL-2737 (APL-2555 AC2): on a phone sheet a 300-character blocked reason is on screen in full.
// The box grows past five lines to fit it, so it does not scroll inside, and the 150-character title does not scroll sideways.
// Needs a running app (TASKBOARD_URL) on a TEST database. Creates its own ZZ-TEST project and archives it afterwards.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator } from "playwright-core";
import { account, BASE, patchTask, project, PW, SUPER_EMAIL, superAdmin, task, type Account } from "../helpers";

const TITLE = "ZZ-TEST blocked reason title that wraps across several lines on a phone sheet so nothing scrolls sideways at three hundred twenty px wide okay".padEnd(150, " x");
const REASON = "Waiting on the signed paperwork from the vendor before finance can review the invoice and release the next milestone payment for the rollout. Legal also asked for a revised data processing addendum, and the regional lead is away until Thursday, so nobody can approve the changes to the delivery plan.";

let browser: Browser;
let root: Account | undefined;
let viewer: Account;
let projectId = "";
let taskId = "";

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error(`Refusing to run against ${BASE}: use a local server with a test database.`);
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  root = await superAdmin();
  viewer = await account("zzbrviewer");
  const p = await project(root, root, [{ who: viewer, role: "VIEWER" }]);
  projectId = p.id;
  taskId = await task(root, projectId, { title: TITLE });
  const r = await patchTask(root, taskId, { blocked: true, blockedReason: REASON });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}, 90000);

afterAll(async () => {
  try {
    if (root && projectId) expect([200, 409]).toContain((await root.c.post(`/api/projects/${projectId}/archive`)).status);
  } finally {
    await browser?.close();
  }
});

async function openSheet(width: number, email: string) {
  const ctx = await browser.newContext({ viewport: { width, height: 700 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, baseURL: BASE });
  const signed = await ctx.request.post("/api/auth/signin", { data: { email, password: PW } });
  expect(signed.ok(), "sign in").toBe(true);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  const dialog = page.getByRole("dialog", { name: "Task" });
  const reason = dialog.getByLabel("Why is it blocked?");
  await expect.poll(() => reason.count(), { timeout: 20000 }).toBe(1);
  await page.evaluate(() => document.fonts.ready);
  return { page, dialog, reason };
}

const metrics = (el: Locator) => el.evaluate((e) => {
  const cs = getComputedStyle(e);
  return {
    sw: e.scrollWidth, cw: e.clientWidth, sh: e.scrollHeight, ch: e.clientHeight,
    lineHeight: parseFloat(cs.lineHeight), overflowY: cs.overflowY,
    value: e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement ? e.value : e.textContent ?? "",
  };
});

describe("qa:TC missing APL-2737 a 300-character blocked reason is fully readable on a phone sheet", () => {
  it("qa:TC missing AC1: at 320 px the title does not scroll sideways and the 300-character reason is not clipped vertically", async () => {
    expect(TITLE).toHaveLength(150);
    expect(REASON).toHaveLength(300);
    const { page, dialog, reason } = await openSheet(320, SUPER_EMAIL);
    try {
      const title = dialog.getByLabel("Title");
      const t = await metrics(title);
      expect(t.value).toBe(TITLE);
      expect(t.sw, "title scrolls sideways").toBeLessThanOrEqual(t.cw + 1);
      const r = await metrics(reason);
      expect(r.value).toBe(REASON);
      expect(r.sw, "blocked reason scrolls sideways").toBeLessThanOrEqual(r.cw + 1);
      expect(r.sh, "blocked reason is clipped vertically").toBeLessThanOrEqual(r.ch + 2);
      expect(r.overflowY).toBe("hidden");
      // It got here by growing past the old five-line cap, not by the reason being short.
      expect(r.ch).toBeGreaterThan(r.lineHeight * 5);
      const pg = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(pg.sw).toBeLessThanOrEqual(pg.iw + 1);
    } finally { await page.context().close(); }
  });

  it("qa:TC missing AC1: the reason stays fully readable at the other phone widths and for a Viewer (read-only box)", async () => {
    for (const [width, email] of [[360, SUPER_EMAIL], [390, SUPER_EMAIL], [320, viewer.email]] as const) {
      const { page, reason } = await openSheet(width, email);
      try {
        const r = await metrics(reason);
        expect(r.value, `${width} ${email}`).toBe(REASON);
        expect(r.sw, `${width} ${email} scrolls sideways`).toBeLessThanOrEqual(r.cw + 1);
        expect(r.sh, `${width} ${email} clipped vertically`).toBeLessThanOrEqual(r.ch + 2);
      } finally { await page.context().close(); }
    }
  });

  it("qa:TC missing AC1: typing the reason up to 300 characters grows the box with it, with no scrolling inside", async () => {
    const { page, reason } = await openSheet(320, SUPER_EMAIL);
    try {
      await reason.fill("");
      await reason.pressSequentially(REASON.slice(0, 40));
      const short = await metrics(reason);
      expect(short.sh).toBeLessThanOrEqual(short.ch + 2);
      await reason.fill(REASON);
      await reason.dispatchEvent("input");
      const full = await metrics(reason);
      expect(full.ch).toBeGreaterThan(short.ch);
      expect(full.sh, "clipped vertically after typing").toBeLessThanOrEqual(full.ch + 2);
      // Leave without saving: the reason on the task stays as it was.
      await reason.fill(REASON);
    } finally { await page.context().close(); }
  });
});
