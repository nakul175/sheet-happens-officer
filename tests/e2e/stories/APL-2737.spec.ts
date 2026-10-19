// APL-2737 story spec (APL-2555 AC2): on a phone sheet a 300-character blocked reason is on screen in full.
// The box grows past five lines to fit it, so it does not scroll inside, and the 150-character title does not scroll sideways.
// workers=1: the cases in this file run one after another, and the suite runs one file at a time.
// Local only: TASKBOARD_URL must be a server on this machine with a test database; any other host, production included, is refused.
// Thrown-away people and projects use ZZ-TEST names and nakul17+ aliases, then afterAll archives
// the project and deactivates the people. Self-signup only accepts @aplyd.com, so the alias is
// nakul17+…@aplyd.com.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Locator } from "playwright-core";
import { account, BASE, patchTask, PW, SUPER_EMAIL, superAdmin, task, type Account } from "../../helpers";

if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error(`Refusing to run against ${BASE}: use a local server with a test database.`);

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;

/** Chromium for playwright-core: PW_CHROMIUM, then a system Chrome (the CI runner has one), then Playwright's own download. */
function chromePath() {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

const TITLE = "ZZ-TEST blocked reason title that wraps across several lines on a phone sheet so nothing scrolls sideways at three hundred twenty px wide okay".padEnd(150, " x");
const REASON = "Waiting on the signed paperwork from the vendor before finance can review the invoice and release the next milestone payment for the rollout. Legal also asked for a revised data processing addendum, and the regional lead is away until Thursday, so nobody can approve the changes to the delivery plan.";

let browser: Browser;
let root: Account | undefined;
let viewer: Account | undefined;
let projectId = "";
let taskId = "";

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: chromePath() });
  root = await superAdmin();
  viewer = await account(`ZZ-TEST viewer ${RUN}`, `nakul17+zz-2737-${RUN}-viewer@aplyd.com`);
  const p = await root.c.post("/api/projects", { name: `ZZ-TEST 2737 ${RUN}`, leaderId: root.id });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  projectId = p.json.project.id as string;
  expect((await root.c.post(`/api/projects/${projectId}/members`, { userId: viewer.id, role: "VIEWER" })).status).toBe(201);
  taskId = await task(root, projectId, { title: TITLE });
  const r = await patchTask(root, taskId, { blocked: true, blockedReason: REASON });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}, 90000);

afterAll(async () => {
  try {
    if (root && projectId) expect([200, 409]).toContain((await root.c.post(`/api/projects/${projectId}/archive`)).status);
    if (root && viewer) {
      const off = await root.c.post(`/api/team/${viewer.id}/deactivate`, { reassign: "leaders" });
      expect(off.status === 200 || (off.status === 409 && /already deactivated/.test(off.json?.error ?? "")), JSON.stringify(off.json)).toBe(true);
    }
  } finally {
    await browser?.close();
  }
});

async function openSheet(width: number, email: string, height = 700) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, baseURL: BASE });
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

describe("@APL-2737 qa:TC missing a 300-character blocked reason is fully readable on a phone sheet", () => {
  it("@APL-2737 @AC1 qa:TC missing at 320 px the title does not scroll sideways and the 300-character reason is not clipped vertically", async () => {
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
      // auto, not hidden: if the width ever changes before the next fit, the rest stays reachable (Pam D2).
      expect(r.overflowY).toBe("auto");
      // It got here by growing past the old five-line cap, not by the reason being short.
      expect(r.ch).toBeGreaterThan(r.lineHeight * 5);
      const pg = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(pg.sw).toBeLessThanOrEqual(pg.iw + 1);
    } finally { await page.context().close(); }
  });

  it("@APL-2737 @AC1 qa:TC missing the reason stays fully readable at the other phone widths and for a Viewer (read-only box)", async () => {
    for (const [width, email] of [[360, SUPER_EMAIL], [390, SUPER_EMAIL], [320, viewer!.email]] as const) {
      const { page, reason } = await openSheet(width, email);
      try {
        const r = await metrics(reason);
        expect(r.value, `${width} ${email}`).toBe(REASON);
        expect(r.sw, `${width} ${email} scrolls sideways`).toBeLessThanOrEqual(r.cw + 1);
        expect(r.sh, `${width} ${email} clipped vertically`).toBeLessThanOrEqual(r.ch + 2);
      } finally { await page.context().close(); }
    }
  });

  it("@APL-2737 @AC1 qa:TC missing typing the reason up to 300 characters grows the box with it, with no scrolling inside", async () => {
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

  it("@APL-2737 @AC1 qa:TC missing after rotating from landscape to portrait the box is fitted again and the whole reason is still on screen", async () => {
    // Opened in landscape (568 x 320), then rotated to portrait (320 x 568). The narrower box wraps to more lines.
    const { page, reason } = await openSheet(568, SUPER_EMAIL, 320);
    try {
      const wide = await metrics(reason);
      expect(wide.value).toBe(REASON);
      expect(wide.sh, "landscape clipped vertically").toBeLessThanOrEqual(wide.ch + 2);
      await page.setViewportSize({ width: 320, height: 568 });
      await expect.poll(async () => {
        const m = await metrics(reason);
        return m.sh - m.ch;
      }, { timeout: 5000, message: "portrait: the box was not fitted again after rotation" }).toBeLessThanOrEqual(2);
      const tall = await metrics(reason);
      expect(tall.ch, "portrait box is taller than landscape").toBeGreaterThan(wide.ch);
      expect(tall.sw, "portrait scrolls sideways").toBeLessThanOrEqual(tall.cw + 1);
    } finally { await page.context().close(); }
  });

  it("@APL-2737 @AC1 qa:TC missing the field stops at 300 characters, the limit the server accepts", async () => {
    const { page, reason } = await openSheet(320, SUPER_EMAIL);
    try {
      expect(await reason.getAttribute("maxlength")).toBe("300");
      await reason.fill(REASON);
      await reason.press("End");
      await reason.pressSequentially("abcd"); // typed keys past the limit are ignored
      expect((await metrics(reason)).value).toBe(REASON);
      // Leave without saving: the reason on the task stays as it was.
    } finally { await page.context().close(); }
  });
});
