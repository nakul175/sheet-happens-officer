// APL-2692 (APL-2536 AC5): at 390x844 the organisation page and the Accounts list
// must not scroll the document sideways. A wide table may scroll inside its own box,
// and that box has to be a keyboard target. Desktop columns stay where they are.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";

const NAME = "ZZ-TEST-11 narrow org mve8ij02tlmf";
const DEAL = "ZZ-TEST-11 narrow deal mve8ij02tlmf";

function chrome() {
  if (process.env.PW_CHROMIUM && existsSync(process.env.PW_CHROMIUM)) return process.env.PW_CHROMIUM;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]) {
    if (existsSync(p)) return p;
  }
  return undefined;
}

const href = (rel: string) => pathToFileURL(join(process.cwd(), rel)).href;

function documentHtml(main: string) {
  const sheets = [
    "src/app/globals.css",
    "src/app/(app)/app.css",
    "src/app/(app)/touch.css",
    "src/app/(app)/density.css",
    "src/app/(app)/bell.css",
    "src/components/extras/extras.css",
    "src/app/(app)/accounts/scroll.css",
  ].map((p) => `<link rel="stylesheet" href="${href(p)}" />`).join("");
  const font = `@font-face{font-family:"Public Sans";src:url("${href("src/app/fonts/PublicSans-Regular.woff2")}") format("woff2");font-weight:400}
@font-face{font-family:"Public Sans";src:url("${href("src/app/fonts/PublicSans-Medium.woff2")}") format("woff2");font-weight:500}
@font-face{font-family:"Public Sans";src:url("${href("src/app/fonts/PublicSans-SemiBold.woff2")}") format("woff2");font-weight:600}
:root{--font-public-sans:"Public Sans"}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<style>${font}</style>${sheets}</head><body>
<div class="shell">
  <a class="skip" href="#main">Skip to content</a>
  <aside class="side" aria-label="Main"><a class="brand" href="/">Sheet Happens Officer</a>
    <nav class="nav"><a href="/accounts" aria-current="page">Accounts</a></nav></aside>
  <div class="main">
    <header class="top">
      <button class="burger" aria-label="Open menu">☰</button>
      <span class="top-brand">SHO</span><span class="grow"></span>
      <button class="btn sm newtask">+ New task</button>
      <div class="wrapper"><button class="bell" aria-label="Notifications">🔔<span class="badge">8</span></button></div>
    </header>
    ${main}
  </div>
  <div class="tabbar-wrap"><nav class="tabbar" aria-label="Main">
    <a href="/">My tasks</a><a href="/projects">Projects</a><a href="/search">Search</a><button>More</button>
  </nav></div>
</div></body></html>`;
}

/** Accounts list with a search filled in, the same state as /accounts?q=… */
function accountsMain(scroll: string) {
  return `<main id="main" class="content" tabindex="-1">
    <div class="head"><div class="grow"><h1 class="pt">Accounts</h1><p class="sub">Organisations you can start deals with</p></div>
      <button class="btn">+ New organisation</button></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <input class="in" style="max-width:360px" aria-label="Search organisations" value="${NAME}" />
      <select class="in" style="max-width:200px" aria-label="Kind"><option>All kinds</option><option>Ministry</option><option>Public Intsitution</option></select>
    </div>
    <div ${scroll}>
      <table class="tbl"><thead><tr><th>Name</th><th>Kind</th><th>Country</th><th>Under</th><th>Open deals</th></tr></thead>
        <tbody><tr><td><a href="/accounts/x">${NAME}</a></td><td>Ministry</td><td>—</td><td>—</td><td>0</td></tr></tbody></table>
    </div>
  </main>`;
}

/** Organisation page, with and without the open-deals table. */
function orgMain(deals: boolean) {
  const table = deals
    ? `<div class="acct-scroll" tabindex="0" aria-label="Open deals"><table class="tbl">
        <thead><tr><th>Deal</th><th>Role</th><th>Stage</th><th>Leader</th></tr></thead>
        <tbody><tr><td><a href="/projects/x">${DEAL}</a></td><td>Buyer</td><td>Lead <span style="color:var(--muted)">Proactive</span></td><td>Ada</td></tr></tbody></table></div>`
    : `<div class="card empty">No deals you can see yet.</div>`;
  return `<main id="main" class="content" tabindex="-1">
    <div class="head"><div class="grow"><h1 class="pt">${NAME}</h1><p class="sub crumb"><a href="/accounts">Accounts</a></p></div>
      <a class="btn" href="/deals/new?org=x">+ Deal</a>
      <button class="btn ghost">Archive</button>
      <button class="btn ghost">History</button></div>
    <p class="meta" style="justify-content:flex-start"><span class="chip">Ministry</span></p>
    <div class="grp">Open deals</div>
    ${table}
  </main>`;
}

const NOW = `class="acct-scroll" tabindex="0" aria-label="Accounts"`;
const THEN = `style="overflow-x:auto"`;

type Box = { label: string | null; tab: string | null; extra: number; right: number; left: number; width: number; height: number; cls: string };
type Measure = {
  scrollWidth: number; clientWidth: number; innerWidth: number; bodyScrollWidth: number;
  boxes: Box[]; headers: { text: string; x: number; w: number }[]; display: string;
};

function measure(): Measure {
  const de = document.documentElement;
  const boxes: Box[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("body *")) {
    const ox = getComputedStyle(el).overflowX;
    if (ox !== "auto" && ox !== "scroll") continue;
    const extra = el.scrollWidth - el.clientWidth;
    if (extra <= 1) continue;
    const r = el.getBoundingClientRect();
    boxes.push({
      label: el.getAttribute("aria-label"), tab: el.getAttribute("tabindex"), extra,
      right: r.right, left: r.left, width: r.width, height: r.height,
      cls: typeof el.className === "string" ? el.className : "",
    });
  }
  const table = document.querySelector("table.tbl");
  const headers = [...document.querySelectorAll("table.tbl th")].map((th) => {
    const r = th.getBoundingClientRect();
    return { text: (th.textContent || "").trim(), x: Math.round(r.x), w: Math.round(r.width) };
  });
  return {
    scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, innerWidth: window.innerWidth,
    bodyScrollWidth: document.body.scrollWidth, boxes, headers,
    display: table ? getComputedStyle(table).display : "",
  };
}

let browser: Browser;
let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "apl-2692-"));
  const args = ["--no-sandbox", "--disable-dev-shm-usage"];
  if (process.env.PW_CHROMIUM && existsSync(process.env.PW_CHROMIUM)) {
    browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, args });
    return;
  }
  try {
    browser = await chromium.launch({ args });
  } catch {
    const executablePath = chrome();
    if (!executablePath) throw new Error("No Chromium. Set PW_CHROMIUM.");
    browser = await chromium.launch({ executablePath, args });
  }
});
afterAll(async () => {
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function open(html: string, width: number, height: number) {
  const file = join(dir, `p-${width}-${Math.random().toString(16).slice(2)}.html`);
  writeFileSync(file, html);
  const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })).newPage();
  await page.goto(pathToFileURL(file).href);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

function pageFits(m: Measure) {
  expect(m.scrollWidth, "document scrollWidth").toBeLessThanOrEqual(m.innerWidth + 1);
  expect(m.scrollWidth - m.clientWidth, "document scrollWidth - clientWidth").toBeLessThanOrEqual(1);
  expect(m.bodyScrollWidth, "body scrollWidth").toBeLessThanOrEqual(m.innerWidth + 1);
}

describe("APL-2692 accounts sideways scroll", () => {
  it("puts the keyboard target on the table wrapper in both views", () => {
    const list = readFileSync("src/app/(app)/accounts/AccountsView.tsx", "utf8");
    const org = readFileSync("src/app/(app)/accounts/[id]/OrgView.tsx", "utf8");
    expect(list).toContain('className="acct-scroll" tabIndex={0} aria-label="Accounts"');
    expect(org).toContain('className="acct-scroll" tabIndex={0} aria-label="Open deals"');
    expect(list).not.toContain("overflowX");
    expect(org).not.toContain("overflowX");
  });

  it("AC1 and AC2: /accounts?q= at 390x844 does not scroll the page, and the table scroller is inside its box", async () => {
    const page = await open(documentHtml(accountsMain(NOW)), 390, 844);
    const m = await page.evaluate(measure);
    pageFits(m);
    expect(m.boxes, "sideways scrollers").toHaveLength(1);
    const box = m.boxes[0];
    expect(box.cls).toContain("acct-scroll");
    expect(box.label).toBe("Accounts");
    expect(box.tab).toBe("0");
    expect(box.left).toBeGreaterThanOrEqual(-1);
    expect(box.right).toBeLessThanOrEqual(m.innerWidth + 1);
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.extra).toBeGreaterThan(1);
    const scroller = page.locator(".acct-scroll");
    await scroller.focus();
    expect(await page.evaluate(() => document.activeElement?.classList.contains("acct-scroll"))).toBe(true);
    const before = await scroller.evaluate((el) => el.scrollLeft);
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(80);
    await page.keyboard.up("ArrowRight");
    const after = await scroller.evaluate((el) => el.scrollLeft);
    expect(after).toBeGreaterThan(before);
    await page.context().close();
  });

  it("AC1 and AC2: /accounts/{id} at 390x844 does not scroll the page", async () => {
    const bare = await open(documentHtml(orgMain(false)), 390, 844);
    pageFits(await bare.evaluate(measure));
    expect((await bare.evaluate(measure)).boxes).toEqual([]);
    await bare.context().close();

    const page = await open(documentHtml(orgMain(true)), 390, 844);
    const m = await page.evaluate(measure);
    pageFits(m);
    expect(m.boxes).toHaveLength(1);
    expect(m.boxes[0].label).toBe("Open deals");
    expect(m.boxes[0].tab).toBe("0");
    expect(m.boxes[0].right).toBeLessThanOrEqual(m.innerWidth + 1);
    expect(m.boxes[0].width).toBeGreaterThanOrEqual(44);
    expect(m.boxes[0].height).toBeGreaterThanOrEqual(44);
    const scroller = page.locator(".acct-scroll");
    await scroller.focus();
    expect(await page.evaluate(() => document.activeElement?.classList.contains("acct-scroll"))).toBe(true);
    await page.keyboard.down("ArrowRight");
    await page.waitForTimeout(80);
    await page.keyboard.up("ArrowRight");
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    await page.context().close();
  });

  it("AC3: at 1280x800 the columns sit where they did before this change", async () => {
    for (const [now, then] of [
      [accountsMain(NOW), accountsMain(THEN)],
      [orgMain(true), orgMain(true).replace('class="acct-scroll" tabindex="0" aria-label="Open deals"', THEN)],
    ] as const) {
      const next = await open(documentHtml(now), 1280, 800);
      const prev = await open(documentHtml(then), 1280, 800);
      const a = await next.evaluate(measure);
      const b = await prev.evaluate(measure);
      pageFits(a);
      pageFits(b);
      expect(a.boxes, "desktop table should fit without a sideways scroller").toEqual([]);
      expect(b.boxes).toEqual([]);
      expect(a.display).toBe("table");
      expect(a.headers.map((h) => h.text)).toEqual(b.headers.map((h) => h.text));
      expect(a.headers.length).toBeGreaterThan(0);
      for (let i = 0; i < a.headers.length; i++) {
        expect(Math.abs(a.headers[i].x - b.headers[i].x)).toBeLessThanOrEqual(1);
        expect(Math.abs(a.headers[i].w - b.headers[i].w)).toBeLessThanOrEqual(1);
      }
      await next.context().close();
      await prev.context().close();
    }
  });
});
