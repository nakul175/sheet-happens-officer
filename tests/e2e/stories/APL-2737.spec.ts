// APL-2737 story spec (APL-2555 AC2): on a phone sheet a 300-character blocked reason is on screen in full.
// The box grows past five lines to fit it, so it does not scroll inside, and the 150-character title does not scroll sideways.
// workers=1: the cases in this file run one after another, and the suite runs one file at a time.
// Local only: TASKBOARD_URL must be a server on this machine with a test database; any other host, production included, is refused.
// Thrown-away people and projects use ZZ-TEST names and nakul17+ aliases, then afterAll archives
// the project and deactivates the people. Self-signup only accepts @aplyd.com, so the alias is
// nakul17+…@aplyd.com.
// Playwright (APL-2911): ci.yml runs it against the CI server after npm test. The API calls go through ../local-api,
// which has no vitest import, so Playwright can load this file.
import { expect, test, type Browser, type Locator } from "@playwright/test";
import { account, BASE, patchTask, PW, SUPER_EMAIL, superAdmin, task, type Account } from "../local-api";

if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error(`Refusing to run against ${BASE}: use a local server with a test database.`);

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;

const TITLE = "ZZ-TEST blocked reason title that wraps across several lines on a phone sheet so nothing scrolls sideways at three hundred twenty px wide okay".padEnd(150, " x");
const REASON = "Waiting on the signed paperwork from the vendor before finance can review the invoice and release the next milestone payment for the rollout. Legal also asked for a revised data processing addendum, and the regional lead is away until Thursday, so nobody can approve the changes to the delivery plan.";

let browser: Browser;
let root: Account | undefined;
let viewer: Account | undefined;
let projectId = "";
let taskId = "";

// The browser is Playwright's own (playwright.config.ts: PW_CHROMIUM or the installed Chromium).
test.beforeAll(async ({ browser: b }) => {
  test.setTimeout(90000);
  browser = b;
  root = await superAdmin();
  viewer = await account(`ZZ-TEST viewer ${RUN}`, `nakul17+zz-2737-${RUN}-viewer@aplyd.com`);
  const p = await root.c.post("/api/projects", { name: `ZZ-TEST 2737 ${RUN}`, leaderId: root.id });
  expect(p.status, JSON.stringify(p.json)).toBe(201);
  projectId = p.json.project.id as string;
  expect((await root.c.post(`/api/projects/${projectId}/members`, { userId: viewer.id, role: "VIEWER" })).status).toBe(201);
  taskId = await task(root, projectId, { title: TITLE });
  const r = await patchTask(root, taskId, { blocked: true, blockedReason: REASON });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
});

test.afterAll(async () => {
  if (root && projectId) expect([200, 409]).toContain((await root.c.post(`/api/projects/${projectId}/archive`)).status);
  if (root && viewer) {
    const off = await root.c.post(`/api/team/${viewer.id}/deactivate`, { reassign: "leaders" });
    expect(off.status === 200 || (off.status === 409 && /already deactivated/.test(off.json?.error ?? "")), JSON.stringify(off.json)).toBe(true);
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

test.describe("qa:TC missing APL-2737 a 300-character blocked reason is fully readable on a phone sheet", { tag: "@local-only" }, () => {
  test("qa:TC missing AC1: at 320 px the title does not scroll sideways and the 300-character reason is not clipped vertically", async () => {
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

  test("qa:TC missing AC1: the reason stays fully readable at the other phone widths and for a Viewer (read-only box)", async () => {
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

  test("qa:TC missing AC1: filling the field with a 300-character reason grows the box, with no scrolling inside", async () => {
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

  test("qa:TC missing AC1: typing a multi-line reason grows the box on every line, pasting grows it again, and overflow-y is never hidden", async () => {
    const { page, reason } = await openSheet(320, SUPER_EMAIL);
    try {
      await reason.fill("");
      await reason.focus();
      const lines = ["Waiting on legal sign-off", "Vendor sends the DPA Thursday", "Finance holds the invoice", "Regional lead is away"];
      let previous = (await metrics(reason)).ch;
      for (const [i, line] of lines.entries()) {
        if (i > 0) await page.keyboard.press("Enter");
        await page.keyboard.type(line);
        const m = await metrics(reason);
        expect(m.overflowY, `after typing line ${i + 1}`).not.toBe("hidden");
        expect(m.sh, `line ${i + 1} clipped vertically`).toBeLessThanOrEqual(m.ch + 2);
        if (i > 0) expect(m.ch, `the box grew for line ${i + 1}`).toBeGreaterThan(previous);
        previous = m.ch;
      }

      // Paste three more lines with the keyboard shortcut, the way a person would.
      const pasted = "\nPaste one\nPaste two\nPaste three";
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.evaluate((text) => navigator.clipboard.writeText(text), pasted);
      await reason.press("End");
      await page.keyboard.press("ControlOrMeta+KeyV");
      await expect.poll(async () => (await metrics(reason)).value).toBe(`${lines.join("\n")}${pasted}`);
      const afterPaste = await metrics(reason);
      expect(afterPaste.overflowY, "after paste").not.toBe("hidden");
      expect(afterPaste.ch, "the box grew for the pasted lines").toBeGreaterThan(previous);
      expect(afterPaste.sh, "pasted text clipped vertically").toBeLessThanOrEqual(afterPaste.ch + 2);

      // Leave without saving: the reason on the task stays as it was.
      await reason.fill(REASON);
    } finally { await page.context().close(); }
  });

  test("qa:TC missing AC1: after rotating from landscape to portrait the box is fitted again and the whole reason is still on screen", async () => {
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

  test("qa:TC missing AC1: the field stops at 300 characters, the limit the server accepts", async () => {
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
