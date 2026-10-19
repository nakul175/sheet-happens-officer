// APL-2738 story spec (APL-2555 AC5): on a phone, with the keyboard open and the description focused,
// the description and the footer stay inside the visible sheet, and the sheet follows visualViewport.
// Desktop Chromium has no on-screen keyboard, so the page gets a visualViewport that behaves like
// iOS Safari's: the layout viewport keeps its height and only visualViewport shrinks (and may move down).
// workers=1: the cases in this file run one after another, and the suite runs one file at a time.
// Local server with a test database only (TASKBOARD_URL on localhost); any other host is refused, production included.
// It signs in as the local test Super Admin, makes a ZZ-TEST project, task and subtasks, and afterAll archives the project.
// Browser: PW_CHROMIUM if set, else Playwright's own Chromium if installed, else the system Chrome.
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { BASE, PW, superAdmin, task, type Account } from "../../helpers";

if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error(`Refusing to run against ${BASE}: use a local server with a test database.`);

const PHONE = { width: 390, height: 800 };
const DESK = { width: 1024, height: 800 };

let browser: Browser;
let root: Account;
let projectId = "";
let taskId = "";

function launch() {
  if (process.env.PW_CHROMIUM) return chromium.launch({ executablePath: process.env.PW_CHROMIUM });
  if (existsSync(chromium.executablePath())) return chromium.launch();
  return chromium.launch({ channel: "chrome" });
}

beforeAll(async () => {
  browser = await launch();
  root = await superAdmin();
  const made = await root.c.post("/api/projects", { name: `ZZ-TEST APL-2738 keyboard sheet ${Date.now()}`, leaderId: root.id });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  projectId = made.json.project.id as string;
  taskId = await task(root, projectId, { title: "ZZ-TEST APL-2738 keyboard sheet", description: "Line of description.\n".repeat(60) });
  for (const t of ["one", "two", "three", "four", "five"]) {
    expect((await root.c.post(`/api/projects/${projectId}/tasks`, { title: `ZZ-TEST APL-2738 subtask ${t}`, parentId: taskId })).status).toBe(201);
  }
}, 60000);

afterAll(async () => {
  try {
    if (root && projectId) expect([200, 409]).toContain((await root.c.post(`/api/projects/${projectId}/archive`)).status);
  } finally {
    await browser?.close();
  }
});

/** Opens the task sheet with a stand-in visualViewport. window.__keyboard(h, top) shrinks it like an opening keyboard. */
async function openSheet(viewport: { width: number; height: number }) {
  const phone = viewport.width < 600;
  const ctx = await browser.newContext({ viewport, hasTouch: phone, isMobile: phone, deviceScaleFactor: 1, baseURL: BASE });
  await ctx.addInitScript(() => {
    const vv = new EventTarget() as EventTarget & Record<string, number>;
    let h: number | null = null, top = 0;
    const props: Record<string, () => number> = {
      height: () => h ?? window.innerHeight, width: () => window.innerWidth, offsetTop: () => top, offsetLeft: () => 0,
      pageTop: () => window.scrollY + top, pageLeft: () => window.scrollX, scale: () => 1,
    };
    for (const [k, get] of Object.entries(props)) Object.defineProperty(vv, k, { get });
    Object.defineProperty(window, "visualViewport", { configurable: true, get: () => vv });
    (window as unknown as { __keyboard: (height: number | null, offsetTop?: number) => void }).__keyboard = (height, offsetTop = 0) => {
      h = height; top = offsetTop;
      vv.dispatchEvent(new Event("resize"));
      vv.dispatchEvent(new Event("scroll"));
    };
  });
  const signed = await ctx.request.post("/api/auth/signin", { data: { email: "root.test@aplyd.com", password: PW } });
  expect(signed.ok(), "sign in").toBe(true);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}?task=${taskId}`, { waitUntil: "load" });
  await page.getByRole("dialog", { name: "Task" }).waitFor({ timeout: 30000 });
  await page.locator("#desc").waitFor({ timeout: 15000 });
  // The person types once the sheet has finished loading: wait until the fields above the description stop moving.
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => {
    const w = window as unknown as { __last?: number; __same?: number };
    const y = document.querySelector<HTMLElement>("#desc")!.offsetTop;
    w.__same = w.__last === y ? (w.__same ?? 0) + 1 : 0;
    w.__last = y;
    return w.__same >= 5;
  }, undefined, { timeout: 15000, polling: 100 });
  return page;
}

async function keyboard(page: Page, height: number | null, offsetTop = 0) {
  await page.evaluate(([h, t]) => (window as unknown as { __keyboard: (h: number | null, t: number) => void }).__keyboard(h, t), [height, offsetTop] as const);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

type R = { top: number; bottom: number };
async function rects(page: Page) {
  return page.evaluate(() => {
    const r = (sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: b.top, bottom: b.bottom };
    };
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Task"]')!;
    const close = [...dialog.querySelectorAll<HTMLElement>(".bar button")].find((b) => b.textContent?.trim() === "Close")!.getBoundingClientRect();
    const foot = dialog.querySelector<HTMLElement>(".sheet-foot");
    return {
      scrim: r(".scrim")!, desc: r("#desc")!, bar: r('[role="dialog"] .bar')!, foot: r(".sheet-foot"),
      close: { top: close.top, bottom: close.bottom },
      footButtons: foot ? [...foot.querySelectorAll("button")].map((b) => b.textContent?.trim()) : [],
      footPosition: foot ? getComputedStyle(foot).position : "",
      focused: document.activeElement?.id ?? "",
    };
  });
}

function inside(what: string, r: R, top: number, bottom: number) {
  expect(r.top, `${what} top`).toBeGreaterThanOrEqual(top - 1);
  expect(r.bottom, `${what} bottom`).toBeLessThanOrEqual(bottom + 1);
}

describe("qa:TC missing APL-2738 task sheet with the keyboard open", () => {
  it("qa:TC missing AC1: the focused description and the pinned footer stay inside the visible sheet when the visible area shortens", async () => {
    const page = await openSheet(PHONE);
    try {
      await page.locator("#desc").focus();
      await keyboard(page, 420);
      const m = await rects(page);
      expect(m.focused).toBe("desc");
      // The sheet follows visualViewport.
      expect(m.scrim.top).toBeCloseTo(0, 0);
      expect(m.scrim.bottom).toBeCloseTo(420, 0);
      // The footer is there, sticky, and pinned to the bottom of the visible area.
      expect(m.foot, "the sheet has a footer").not.toBeNull();
      expect(m.footPosition).toBe("sticky");
      expect(m.footButtons).toContain("Mark complete");
      inside("footer", m.foot!, 0, 420);
      expect(m.foot!.bottom).toBeCloseTo(420, 0);
      // Close stays in view at the top.
      inside("Close", m.close, 0, 420);
      // The focused description sits between the sticky bar and the footer, so nothing covers it.
      inside("description", m.desc, m.bar.bottom, m.foot!.top);
    } finally { await page.context().close(); }
  });

  it("qa:TC missing AC1: the sheet follows visualViewport when it moves down the page (iOS offsetTop)", async () => {
    const page = await openSheet(PHONE);
    try {
      await page.locator("#desc").focus();
      await keyboard(page, 380, 60);
      const m = await rects(page);
      expect(m.scrim.top).toBeCloseTo(60, 0);
      expect(m.scrim.bottom).toBeCloseTo(440, 0);
      inside("footer", m.foot!, 60, 440);
      inside("Close", m.close, 60, 440);
      inside("description", m.desc, m.bar.bottom, m.foot!.top);
    } finally { await page.context().close(); }
  });

  it("qa:TC missing AC1: when the keyboard closes the sheet fills the screen again with the footer at the bottom", async () => {
    const page = await openSheet(PHONE);
    try {
      await page.locator("#desc").focus();
      await keyboard(page, 420);
      await keyboard(page, null);
      const m = await rects(page);
      expect(m.scrim.top).toBeCloseTo(0, 0);
      expect(m.scrim.bottom).toBeCloseTo(PHONE.height, 0);
      inside("footer", m.foot!, 0, PHONE.height);
      inside("description", m.desc, m.bar.bottom, m.foot!.top);
    } finally { await page.context().close(); }
  });

  it("qa:TC missing AC1: at 600 px and wider the centred dialog is unchanged and does not follow visualViewport", async () => {
    const page = await openSheet(DESK);
    try {
      await keyboard(page, 420);
      const m = await page.evaluate(() => {
        const s = document.querySelector<HTMLElement>(".scrim")!;
        const foot = document.querySelector<HTMLElement>(".sheet-foot");
        return { height: s.style.height, top: s.style.top, bottom: s.getBoundingClientRect().bottom, footPosition: foot ? getComputedStyle(foot).position : "" };
      });
      expect(m.height).toBe("");
      expect(m.top).toBe("");
      expect(m.bottom).toBeCloseTo(DESK.height, 0);
      expect(m.footPosition).toBe("static");
    } finally { await page.context().close(); }
  });
});
