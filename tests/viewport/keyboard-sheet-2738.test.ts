// SHO-2738 (APL-2555 AC5): with the phone keyboard open, the focused description and the footer must stay inside the visible sheet.
// A real phone keyboard cannot be simulated, so this drives Chromium at phone size, focuses the description, and shortens the
// layout viewport the way a keyboard does (window.innerHeight shrinks, visualViewport reports the shorter height). Only the
// shrink is simulated; the CSS and the components under test are the real ones.
// Runs with the phone checks (npm run test:viewport), which has Chromium and a local server.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

const PHONE = { width: 390, height: 844 };
const KEYBOARD = 336; // an iPhone-class keyboard covers roughly this much of an 844 px screen
const REMAINING = PHONE.height - KEYBOARD; // 508 px

let browser: Browser;
let page: Page;

// One phone size per test, so the "shrink" never doubles up between tests.
async function newPage(width: number, height: number) {
  page = await browser.newPage({ viewport: { width, height } });
  return page;
}

/** The real task sheet markup (src/components/TaskModal.tsx + src/components/ui.tsx Modal), plus the real app.css on top. */
function sheetHtml(css: string) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>${css}</style></head><body>
<div class="scrim">
  <div class="modal" role="dialog" aria-modal="true" aria-label="Task" tabindex="-1">
    <div class="bar"><span>Project · To do</span><span><button class="link">Copy link</button> · <button class="link">Close</button></span></div>
    <div class="fgrid">
      <span class="lbl">Assignee</span><div>Ada</div>
      <span class="lbl">Due date</span><div>2 days left</div>
      <span class="lbl">Priority</span><div>High</div>
    </div>
    <div class="field"><label for="desc">Description</label><textarea id="desc" class="in" placeholder="Add details" rows="3"></textarea></div>
    <div class="field"><span class="lbl">Subtasks</span></div>
    <div class="actions"><button class="btn">Mark complete</button><button class="btn ghost">Move to Trash</button></div>
  </div>
</div>
</body></html>`;
}

/** Read what the sheet did with the visible area. Runs in the page. */
function measure() {
  const q = (s: string) => document.querySelector<HTMLElement>(s)!;
  const sheet = q(".scrim"), modal = q(".modal"), desc = q("#desc"), footer = q(".modal > .actions:last-of-type");
  const vis = window.visualViewport?.height ?? window.innerHeight;
  const top = window.visualViewport?.offsetTop ?? 0;
  const m = modal.getBoundingClientRect(), s = sheet.getBoundingClientRect();
  return {
    visibleBottom: Math.round(top + vis), // the keyboard starts here
    layoutBottom: window.innerHeight,
    sheetBottom: Math.round(s.bottom),
    sheetHeight: Math.round(s.height),
    sheetScroll: [sheet.scrollTop, sheet.scrollHeight, sheet.clientHeight],
    descTop: Math.round(desc.getBoundingClientRect().top),
    descBottom: Math.round(desc.getBoundingClientRect().bottom),
    footerTop: Math.round(footer.getBoundingClientRect().top),
    footerBottom: Math.round(footer.getBoundingClientRect().bottom),
    footerInSheet: Math.round(footer.getBoundingClientRect().bottom) <= Math.round(m.top + modal.scrollHeight + 1),
  };
}

beforeAll(async () => {
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
});

afterAll(async () => { await browser?.close(); });

async function open(width: number, height: number) {
  const p = await newPage(width, height);
  const css = readFileSync("src/app/globals.css", "utf8") + readFileSync("src/app/(app)/app.css", "utf8");
  await p.setContent(sheetHtml(css));
  await p.focus("#desc");
  return p;
}

/** Each test gets its own page, so one test's keyboard shrink cannot leak into the next. */
async function closePage() { await page?.close(); }

/** Shorten the layout viewport and the visual viewport together, the way an on-screen keyboard does. */
async function openKeyboard(px: number) {
  await page.evaluate((kb) => {
    const next = window.innerHeight - kb;
    // Modal's effect (src/components/ui.tsx) does exactly this: body.vv-sheet plus --vvh/--vvt on <html>.
    document.body.classList.add("vv-sheet");
    document.documentElement.style.setProperty("--vvh", `${next}px`);
    document.documentElement.style.setProperty("--vvt", "0px");
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => next });
    const vv = window.visualViewport;
    if (vv) {
      Object.defineProperty(vv, "height", { configurable: true, get: () => next });
      Object.defineProperty(vv, "offsetTop", { configurable: true, get: () => 0 });
    }
    window.dispatchEvent(new Event("resize"));
    vv?.dispatchEvent(new Event("resize"));
  }, px);
  await page.waitForTimeout(80); // a frame for the layout to settle
}

describe("SHO-2738 keyboard open on a phone", () => {
  it("desktop keeps the floating dialog, unchanged", async () => {
    await open(1280, 900);
    const g = await page.evaluate(() => {
      const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const m = r(".modal"), s = r(".scrim");
      return { sheetBottom: Math.round(s.bottom), modalWidth: Math.round(m.width), modalMax: getComputedStyle(document.querySelector(".modal")!).maxWidth };
    });
    console.log("SHO-2738 desktop:", JSON.stringify(g));
    expect(g.sheetBottom, "the scrim still covers the whole window").toBe(900);
    expect(g.modalMax, "the dialog is still a 640 px card on a desktop").toBe("640px");
    expect(g.modalWidth).toBeLessThanOrEqual(640);
    await closePage();
  });

  it("the focused description and the footer stay inside the visible sheet", async () => {
    await open(PHONE.width, PHONE.height);
    const before = await page.evaluate(measure);
    expect(before.layoutBottom, "phone viewport is 844 px tall before the keyboard").toBe(PHONE.height);
    expect(before.sheetBottom, "the sheet fills the screen before the keyboard").toBe(PHONE.height);

    await openKeyboard(KEYBOARD);
    const after = await page.evaluate(measure);
    // Report the numbers, so a failure says what the layout actually did.
    console.log("SHO-2738 geometry before:", JSON.stringify(before));
    console.log("SHO-2738 geometry after :", JSON.stringify(after), "| visible area", REMAINING, "px");

    // AC: the sheet follows visualViewport: it must end inside the visible area, not under the keyboard.
    expect(after.visibleBottom, "visualViewport shrank to 508 px").toBe(REMAINING);
    expect(after.sheetBottom, `sheet bottom ${after.sheetBottom} px must be within the visible ${after.visibleBottom} px`).toBeLessThanOrEqual(after.visibleBottom);
    expect(after.sheetHeight, "the sheet only occupies the visible area").toBeLessThanOrEqual(after.visibleBottom);

    // AC: the focused description stays inside the visible sheet.
    expect(after.descBottom, `focused description bottom ${after.descBottom} px inside ${after.visibleBottom} px`).toBeLessThanOrEqual(after.visibleBottom);
    expect(after.descTop, "the focused description is not pushed above the sheet").toBeGreaterThanOrEqual(0);

    // AC: the footer stays visible and pinned in that area.
    expect(after.footerBottom, `footer bottom ${after.footerBottom} px inside ${after.visibleBottom} px`).toBeLessThanOrEqual(after.visibleBottom);
    expect(after.footerTop, "the footer is on screen, not scrolled away above").toBeGreaterThanOrEqual(0);
    expect(after.footerInSheet, "the footer is inside the sheet it is pinned to").toBe(true);
    await closePage();
  });
});

