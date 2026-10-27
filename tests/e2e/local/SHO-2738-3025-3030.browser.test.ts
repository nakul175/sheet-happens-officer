// SHO-2738 + SHO-3025 + SHO-3030, browser tier (W86). Each of these three was proven in jsdom only:
//   SHO-2738  tests/keyboard-sheet-2738.test.tsx mounts the Modal with a fake visualViewport and a mocked
//             scrollIntoView; tests/viewport/keyboard-sheet-2738.test.ts lays out static markup and sets
//             body.vv-sheet/--vvh itself. Neither opens the real sheet in a real viewport.
//   SHO-3025  tests/dialog-escape-3025.test.tsx presses a synthetic Escape on a synthetic document.
//   SHO-3030  tests/deactivate-dialog-3030.test.tsx mounts Team with fetch stubbed and the shell replaced.
// This file drives the real app in real Chromium: the real Modal, the real app.css, real focus, real keys.
// It runs against a LOCAL server only (localhost), on a throw-away database, and every record it creates is
// named ZZ-TEST. 127.0.0.1 is refused: it prevents hydration in this repo (W47/W53/W54/W57).
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { account, BASE, patchTask, project, PW, superAdmin, task, type Account } from "../../helpers";

const host = new URL(BASE).hostname;
if (host !== "localhost") throw new Error(`Refusing to run against ${host}: this spec needs the localhost origin the dev server hydrates under.`);

/** The repo's PW_CHROMIUM if it is set and present, else the Chromium playwright-core installed. */
function chromePath(): string | undefined {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of ["/usr/local/bin/google-chrome", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]) {
    if (existsSync(p)) return p;
  }
  return undefined; // playwright-core's own registry (chromium-1248 under ~/Library/Caches/ms-playwright)
}

let browser: Browser;
let root: Account;
let taskId = "";
let projectId = "";
let longTaskId = "";
const longTitle = `ZZ-TEST 2555 ${"Long title with readable wrapping. ".repeat(6)}`.slice(0, 150);
const longReason = "A complete blocked reason must stay readable without scrolling inside this field. ".repeat(5).slice(0, 300);
/** SHO-3030: the person who goes, the person named to take the tasks, and the project both are on. */
let leaving: Account;
let named: Account;
let teamProjectId = "";
let teamProjectName = "";

const RUN = Date.now().toString(36);

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
  root = await superAdmin();
  const p = await project(root, root, [], `ZZ-TEST 2738 sheet ${RUN}`);
  projectId = p.id;
  taskId = await task(root, projectId, {
    title: `ZZ-TEST 2738 task ${RUN}`,
    description: Array.from({ length: 30 }, (_, i) => `A line of description ${i}.`).join("\n"),
  });
  longTaskId = await task(root, projectId, { title: longTitle });
  expect((await patchTask(root, longTaskId, { blocked: true, blockedReason: longReason })).status).toBe(200);

  // The name is the throw-away label; the address has to be a real-shaped alias, so it is given explicitly.
  leaving = await account("zzLeaving", `nakul17+zz-3030-leaving-${RUN}@aplyd.com`, `ZZ-TEST 3030 leaving ${RUN}`);
  named = await account("zzNamed", `nakul17+zz-3030-named-${RUN}@aplyd.com`, `ZZ-TEST 3030 named ${RUN}`);
  teamProjectName = `ZZ-TEST 3030 project ${RUN}`;
  const tp = await project(root, root, [{ who: leaving, role: "EDITOR" }, { who: named, role: "VIEWER" }], teamProjectName);
  teamProjectId = tp.id;
  await task(root, teamProjectId, { title: `ZZ-TEST 3030 task ${RUN}` });
}, 240000);

afterAll(async () => {
  // ZZ-TEST clean-up through the API the way the other local stories do it: archive the projects.
  for (const id of [projectId, teamProjectId]) {
    if (id) await root.c.post(`/api/projects/${id}/archive`);
  }
  await browser?.close();
}, 120000);

/** A context signed in by hand, so a test never inherits the cookies of the one before it. */
async function signedIn(email: string, viewport: { width: number; height: number }, mobile = false): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: BASE, viewport, hasTouch: mobile, isMobile: mobile });
  const r = await ctx.request.post("/api/auth/signin", { data: { email, password: PW } });
  expect(r.ok(), `sign in as ${email}`).toBe(true);
  return ctx;
}

/**
 * Open the task sheet from its row, the way a person does: the row has focus, Enter opens it.
 *
 * "The dialog is visible" is not "the sheet can be read", and it is not even "the sheet has a body".
 * Two separate fetches paint after the dialog: `<Skeleton />` while `/api/tasks/:id` is in flight
 * (src/components/TaskModal.tsx:47) and, once that lands, a footer whose primary button is still absent
 * while the *project* fetch is in flight — `role` falls back to "VIEWER" and `canEdit` to false
 * (src/components/TaskModal.tsx:57-59), so "Mark complete" (src/components/TaskModal.tsx:259-260) is not
 * rendered yet. Measured on this tree: the dialog paints at t=477 ms, `#desc` at t=510 ms, the footer at
 * t=538 ms. Reading the geometry in that window threw `page.evaluate: Error: missing element` in 1 of 3 runs.
 * Wait on both conditions here, so every caller gets a sheet it can read.
 */
async function openSheet(page: Page) {
  const row = page.locator(".item.click", { hasText: `ZZ-TEST 2738 task ${RUN}` }).first();
  await row.waitFor({ state: "visible", timeout: 120000 });
  await row.focus();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "Task" });
  await sheet.waitFor({ state: "visible", timeout: 30000 });
  await sheet.locator("#desc").waitFor({ state: "visible", timeout: 30000 });
  // The action bar exists as an empty `.actions` while the project fetch is in flight; wait for the primary
  // action itself, not for its container.
  await sheet.locator(".actions").filter({ hasText: /Mark complete|Close task/ }).first().waitFor({ state: "visible", timeout: 30000 });
  return { row, sheet };
}

describe("W86 hydration: the localhost page is interactive and talks to /api/", () => {
  it("a client click routes without a document load, and the page fetched /api/ first", async () => {
    const ctx = await signedIn(root.email, { width: 1280, height: 900 });
    const page = await ctx.newPage();
    const api: string[] = [];
    page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/api/")) api.push(new URL(r.url()).pathname); });
    try {
      await page.goto(`/projects/${projectId}`, { waitUntil: "load", timeout: 120000 });
      // A marker on the live window: if the click reloads the document this is gone.
      await page.evaluate(() => { (window as unknown as { __w86?: string }).__w86 = "same-document"; });
      const { sheet } = await openSheet(page);
      expect(await page.evaluate(() => (window as unknown as { __w86?: string }).__w86), "the click did not reload the document").toBe("same-document");
      expect(new URL(page.url()).searchParams.get("task"), "the client router put the open task in the URL").toBe(taskId);
      expect(api.length, `the page made API reads: ${api.join(", ")}`).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached", timeout: 15000 });
    } finally {
      await ctx.close();
    }
  }, 180000);
});

describe("SHO-2738: the real sheet, a real phone viewport, a real focus, a shorter viewport", () => {
  it("the focused description and the pinned footer stay inside the visible area after the viewport shrinks like a keyboard", async () => {
    const ctx = await signedIn(root.email, { width: 390, height: 844 }, true);
    const page = await ctx.newPage();
    try {
      await page.goto(`/projects/${projectId}`, { waitUntil: "load", timeout: 120000 });
      const { sheet } = await openSheet(page);

      // The wiring, read from the real element in the real browser: the Modal marked the page and published
      // visualViewport. This is what the jsdom test asserted against a stand-in.
      const wired = await page.evaluate(() => ({
        marked: document.body.classList.contains("vv-sheet"),
        vvh: document.documentElement.style.getPropertyValue("--vvh"),
        vvt: document.documentElement.style.getPropertyValue("--vvt"),
        innerHeight: window.innerHeight,
      }));
      expect(wired.marked, "the real Modal marked body.vv-sheet").toBe(true);
      expect(wired.vvh, "the real Modal published --vvh from visualViewport").toBe(`${wired.innerHeight}px`);
      expect(wired.vvt).toBe("0px");

      // Focus the description for real, then shrink the visible area the way an on-screen keyboard does:
      // a genuine viewport change, not an overwritten window.innerHeight.
      await sheet.locator("#desc").focus();
      expect(await page.evaluate(() => document.activeElement?.id), "the description holds the focus").toBe("desc");

      await page.setViewportSize({ width: 390, height: 508 });
      // The Modal listens to visualViewport resize; wait until it has republished the shorter height.
      await page.waitForFunction(() => document.documentElement.style.getPropertyValue("--vvh") === `${window.innerHeight}px`, undefined, { timeout: 15000 });

      const after = await page.evaluate(() => {
        const r = (el: Element | null, what: string) => { if (!el) throw new Error(`missing ${what}, so its geometry cannot be read`); const b = el.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) }; };
        const modal = document.querySelector(".modal");
        if (!modal) throw new Error("missing .modal: the sheet is not on screen");
        // The sheet's own footer is the action bar that holds the primary action. A later .actions in the
        // same scroll box is the comment composer, which is ordinary content further down the sheet.
        const footerEl = [...modal.querySelectorAll(".actions")].find((a) => /Mark complete/.test(a.textContent ?? ""));
        return {
          visibleBottom: Math.round((window.visualViewport?.offsetTop ?? 0) + (window.visualViewport?.height ?? window.innerHeight)),
          layoutBottom: window.innerHeight,
          vvh: document.documentElement.style.getPropertyValue("--vvh"),
          scrim: r(document.querySelector(".scrim"), ".scrim"),
          modal: { ...r(modal, ".modal"), scrollTop: modal.scrollTop, scrollHeight: modal.scrollHeight },
          desc: r(document.getElementById("desc"), "#desc"),
          footer: r(footerEl ?? null, "the .actions footer holding Mark complete"),
          footerPinned: footerEl ? getComputedStyle(footerEl).position : "missing",
          focused: document.activeElement?.id,
        };
      });
      console.log("SHO-2738 browser geometry after:", JSON.stringify(after));

      expect(after.layoutBottom, "the visible area is 508 px").toBe(508);
      expect(after.visibleBottom, "visualViewport followed the real viewport down").toBe(508);
      expect(after.vvh, "the sheet was re-sized from the shorter visualViewport").toBe("508px");
      expect(after.scrim.bottom, `the sheet ends inside ${after.visibleBottom} px, not under the keyboard`).toBeLessThanOrEqual(after.visibleBottom);
      expect(after.desc.bottom, `the focused description bottom ${after.desc.bottom} is inside ${after.visibleBottom}`).toBeLessThanOrEqual(after.visibleBottom);
      expect(after.desc.top, "the focused description is not pushed above the sheet").toBeGreaterThanOrEqual(0);
      expect(after.footerPinned, "the sheet's action bar is pinned, as app.css says").toBe("sticky");
      expect(after.footer.bottom, `the pinned footer bottom ${after.footer.bottom} is inside ${after.visibleBottom}`).toBeLessThanOrEqual(after.visibleBottom);
      expect(after.footer.top, `the pinned footer top ${after.footer.top} is on screen`).toBeGreaterThanOrEqual(0);
      expect(after.focused, "the description keeps the focus through the resize").toBe("desc");
    } finally {
      await ctx.close();
    }
  }, 240000);
});

describe("SHO-2555: full phone task sheet and complete long fields", () => {
  it.each([320, 390, 599, 600])("keeps Close visible and all 150/300 characters readable at %i px", async width => {
    const ctx = await signedIn(root.email, { width, height: 844 });
    const page = await ctx.newPage();
    try {
      await page.goto(`/projects/${projectId}?task=${longTaskId}`, { waitUntil: "load", timeout: 120000 });
      const sheet = page.getByRole("dialog", { name: "Task", exact: true });
      const title = sheet.getByRole("textbox", { name: "Title", exact: true });
      const reason = sheet.getByRole("textbox", { name: "Why is it blocked?", exact: true });
      await reason.waitFor({ state: "visible", timeout: 30000 });
      expect(await title.inputValue()).toBe(longTitle);
      expect(await reason.inputValue()).toBe(longReason);
      for (const field of [title, reason]) {
        expect(await field.evaluate(el => ({ clippedVertically: el.scrollHeight > el.clientHeight + 2, clippedHorizontally: el.scrollWidth > el.clientWidth + 2 }))).toEqual({ clippedVertically: false, clippedHorizontally: false });
      }
      const box = await sheet.boundingBox();
      expect(box).not.toBeNull();
      if (width < 600) {
        expect(box!.x).toBeLessThanOrEqual(1);
        expect(box!.y).toBeLessThanOrEqual(1);
        expect(box!.width).toBeGreaterThanOrEqual(width - 1);
        expect(box!.height).toBeGreaterThanOrEqual(843);
      } else {
        expect(box!.x).toBeGreaterThan(0);
        expect(Math.abs(box!.x - (width - box!.x - box!.width))).toBeLessThanOrEqual(2);
      }
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
      await sheet.locator(".dialog-body").evaluate(el => { el.scrollTop = el.scrollHeight; });
      const close = await sheet.getByRole("button", { name: "Close", exact: true }).boundingBox();
      expect(close).not.toBeNull();
      expect(close!.width).toBeGreaterThanOrEqual(44);
      expect(close!.height).toBeGreaterThanOrEqual(44);
      expect(close!.y).toBeGreaterThanOrEqual(0);
      expect(close!.y + close!.height).toBeLessThanOrEqual(844);
      await sheet.getByRole("button", { name: "Close", exact: true }).click();
      await sheet.waitFor({ state: "detached", timeout: 15000 });
    } finally { await ctx.close(); }
  }, 180000);
});

describe("SHO-3025: one Escape, one dialog, in a real browser", () => {
  it("Escape closes the sheet and returns focus, and a stacked confirm takes its own Escape only", async () => {
    const ctx = await signedIn(root.email, { width: 390, height: 800 }, true);
    const page = await ctx.newPage();
    try {
      await page.goto(`/projects/${projectId}`, { waitUntil: "load", timeout: 120000 });
      let { row, sheet } = await openSheet(page);

      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached", timeout: 15000 });
      expect(await page.getByRole("dialog").count(), "the sheet is gone").toBe(0);
      expect(await row.evaluate((el) => el === document.activeElement), "focus is back on the task row").toBe(true);

      ({ row, sheet } = await openSheet(page));
      await sheet.getByRole("button", { name: "Move to Trash", exact: true }).click();
      const confirm = page.getByRole("dialog", { name: "Move to Trash?" });
      await confirm.waitFor({ state: "visible", timeout: 15000 });
      expect(await page.getByRole("dialog").count(), "the sheet with the confirm over it").toBe(2);

      // One Escape: the confirm closes, the sheet under it does not - not then, and not a moment later.
      await page.keyboard.press("Escape");
      await confirm.waitFor({ state: "detached", timeout: 15000 });
      await page.waitForTimeout(500);
      expect(await page.getByRole("dialog").count(), "one Escape closed one dialog").toBe(1);
      expect(new URL(page.url()).searchParams.get("task"), "the sheet under it is still open").toBe(taskId);
      await sheet.waitFor({ state: "visible", timeout: 5000 });
      expect(await page.evaluate(() => document.body.style.overflow), "the sheet still holds the scroll lock").toBe("hidden");

      // The second Escape belongs to the sheet.
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached", timeout: 15000 });
      expect(await page.getByRole("dialog").count(), "the second Escape closed the sheet").toBe(0);
      expect(new URL(page.url()).searchParams.has("task"), "the URL no longer names the task").toBe(false);
      expect(await row.evaluate((el) => el === document.activeElement), "focus is back on the task row").toBe(true);
    } finally {
      await ctx.close();
    }
  }, 240000);

  it("an Escape pressed in the mutation that inserts the sheet still closes it", async () => {
    const ctx = await signedIn(root.email, { width: 390, height: 800 }, true);
    const page = await ctx.newPage();
    try {
      await page.goto(`/projects/${projectId}`, { waitUntil: "load", timeout: 120000 });
      const row = page.locator(".item.click", { hasText: `ZZ-TEST 2738 task ${RUN}` }).first();
      await row.waitFor({ state: "visible", timeout: 120000 });
      // A MutationObserver runs in the microtask after the commit that inserted the sheet, before the effects
      // React schedules for after the paint: press Escape exactly there.
      await page.evaluate(() => {
        const w = window as unknown as { __w86Saw?: boolean };
        w.__w86Saw = false;
        const seen = new MutationObserver(() => {
          if (!document.querySelector('[role="dialog"][aria-label="Task"]')) return;
          seen.disconnect();
          w.__w86Saw = true;
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        });
        seen.observe(document.body, { childList: true, subtree: true });
      });
      await row.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => (window as unknown as { __w86Saw?: boolean }).__w86Saw === true, undefined, { timeout: 30000 });
      await page.waitForFunction(() => !document.querySelector('[role="dialog"][aria-label="Task"]'), undefined, { timeout: 15000 });
      expect(await page.locator('[role="dialog"][aria-label="Task"]').count(), "the sheet answered the Escape from the commit that inserted it").toBe(0);
      expect(await row.evaluate((el) => el === document.activeElement), "focus is back on the task row").toBe(true);
    } finally {
      await ctx.close();
    }
  }, 240000);
});

describe("SHO-3030: the deactivate dialog and its summary, mounted by the real Team screen", () => {
  it("the dialog and the summary explain the fallback by the role, not by membership", async () => {
    const ctx = await signedIn(root.email, { width: 1280, height: 900 });
    const page = await ctx.newPage();
    try {
      await page.goto("/team", { waitUntil: "load", timeout: 120000 });
      const row = page.locator("tr", { hasText: leaving.name }).first();
      await row.waitFor({ state: "visible", timeout: 60000 });
      await row.locator("summary").click();
      await row.getByRole("button", { name: "Deactivate", exact: true }).click();

      const dialog = page.getByRole("dialog", { name: `Deactivate ${leaving.name}?` });
      await dialog.waitFor({ state: "visible", timeout: 15000 });
      const hint = await dialog.locator("p.hint").first().textContent();
      expect(hint, "the Deactivate dialog names the role").toContain("is not a Leader or Editor on a project");
      expect(hint, "and never claims membership").not.toMatch(/\bnot on (a|that|those) projects?\b/);

      // A VIEWER is on the project, so its tasks still fall back to its Leader: the summary must say why.
      const handover = dialog.locator("select");
      expect(await handover.locator(`option[value="${named.id}"]`).textContent()).toBe(`${named.name} — ${named.email}`);
      await handover.selectOption({ value: named.id });
      await dialog.getByRole("button", { name: "Deactivate", exact: true }).click();

      const done = page.getByRole("dialog", { name: `${leaving.name} is deactivated` });
      await done.waitFor({ state: "visible", timeout: 30000 });
      const text = (await done.textContent()) ?? "";
      console.log("SHO-3030 summary:", JSON.stringify(text.replace(/\s+/g, " ").trim()));
      expect(text, "the summary counts the handover").toContain("open task");
      expect(text, "the summary names the project that fell back").toContain(teamProjectName);
      expect(text, "the summary explains the fallback by the role").toMatch(/not a Leader or Editor on that project/);
      expect(text, "and never claims the person was merely not on the project").not.toMatch(/\bnot on (a|that|those) projects?\b/);
      await done.getByRole("button", { name: "Close", exact: true }).click();
    } finally {
      await ctx.close();
    }
  }, 240000);
});

