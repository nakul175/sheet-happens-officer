// APL-2673: SHO-US-22.2 AC2. At 390 px, inline-edit cells and the Complete tick have at least 8 px between hit areas.
// Hit area is the border box plus a negative ::after inset, and the gap is the larger of the two axes.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";

const MIN_GAP = 8;
const WIDTHS = [390, 320] as const;

function chromePath() {
  const fromEnv = process.env.PW_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const p of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"]) {
    if (existsSync(p)) return p;
  }
  throw new Error("No Chrome/Chromium binary. Set PW_CHROMIUM.");
}

const href = (rel: string) => pathToFileURL(join(process.cwd(), rel)).href;

function row(title: string, cells: string[]) {
  const buttons = cells.map((text) => `<span class="ic-wrap ic-gap"><button type="button" class="ic-cell ic-hit" aria-label="${text}">${text}</button></span>`).join("");
  return `<div class="item click sel-row">
    <label class="sel"><input type="checkbox" aria-label="Select ${title}" /></label>
    <button class="tick" aria-label="Complete ${title}"></button>
    <div class="t"><b class="ttl">${title}</b></div>
    <div class="meta">${buttons}</div>
  </div>`;
}

function pageHtml() {
  const sheets = [
    "src/app/globals.css",
    "src/app/(app)/app.css",
    "src/app/(app)/projects/[id]/lists.css",
    "src/components/inline.css",
  ].map((p) => `<link rel="stylesheet" href="${href(p)}" />`).join("");
  return `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    ${sheets}</head><body><div class="content"><div class="list">
    ${row("22.2 first", ["Ada", "Medium", "No date"])}
    ${row("A", ["A", "Low", "Today"])}
    ${row("Long", ["Alexandria Worthington-Smith", "Urgent", "31 Oct 2026"])}
  </div></div></body></html>`;
}

type Pair = { a: string; b: string; gap: number };
type Size = { label: string; w: number; h: number };

/** Hit box, then the gap the APL-2550 AC2 spec uses: the larger of the horizontal and vertical separations. */
function measure() {
  const area = (e: Element) => {
    const r = e.getBoundingClientRect();
    const af = getComputedStyle(e, "::after");
    const inset = af.content !== "none" && af.position === "absolute"
      ? [af.top, af.right, af.bottom, af.left].map(parseFloat)
      : [0, 0, 0, 0];
    const grow = (n: number) => (n < 0 ? -n : 0);
    return {
      t: r.top - grow(inset[0]),
      b: r.bottom + grow(inset[2]),
      l: r.left - grow(inset[3]),
      r: r.right + grow(inset[1]),
      w: r.width + grow(inset[1]) + grow(inset[3]),
      h: r.height + grow(inset[0]) + grow(inset[2]),
    };
  };
  const name = (e: Element) => e.getAttribute("aria-label") || e.textContent || e.tagName;
  const pairs: Pair[] = [];
  const sizes: Size[] = [];
  const labelGaps: number[] = [];
  for (const row of document.querySelectorAll(".item")) {
    const els = [...row.querySelectorAll<HTMLElement>("button,a[href],input:not([type=hidden]),select")]
      .filter((e) => e.getBoundingClientRect().width > 0);
    const boxes = els.map((e) => ({ ...area(e), label: name(e).trim(), el: e }));
    for (const b of boxes) {
      if (b.el instanceof HTMLInputElement && (b.el.type === "checkbox" || b.el.type === "radio")) continue;
      sizes.push({ label: b.label, w: b.w, h: b.h });
    }
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const x = boxes[i], y = boxes[j];
      const gx = Math.max(y.l - x.r, x.l - y.r);
      const gy = Math.max(y.t - x.b, x.t - y.b);
      pairs.push({ a: x.label, b: y.label, gap: Math.max(gx, gy) });
    }
    const label = row.querySelector("label.sel");
    const tick = row.querySelector("button.tick");
    if (label && tick) {
      const L = label.getBoundingClientRect();
      const T = area(tick);
      labelGaps.push(Math.max(T.l - L.right, L.left - T.r, T.t - L.bottom, L.top - T.b));
      sizes.push({ label: "checkbox label", w: L.width, h: L.height });
    }
  }
  return {
    width: window.innerWidth,
    pairs,
    sizes,
    labelGaps,
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
}

let browser: Browser;
let dir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "apl-2673-"));
  writeFileSync(join(dir, "row.html"), pageHtml());
  browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
});
afterAll(async () => {
  await browser?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function openAt(width: number) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(join(dir, "row.html")).href);
  return page;
}

describe("APL-2673 inline-edit hit areas", () => {
  it("marks each editable cell with the phone gap classes", () => {
    const src = readFileSync("src/components/inline.tsx", "utf8");
    expect(src).toContain('className="ic-wrap ic-gap"');
    expect(src).toContain("ic-cell ic-hit");
  });
  for (const width of WIDTHS) {
    it(`keeps at least 8 px between adjacent targets at ${width} px`, async () => {
      const page: Page = await openAt(width);
      const found = await page.evaluate(measure);
      await page.context().close();
      expect(found.width).toBe(width);
      const close = found.pairs.filter((p) => p.gap < MIN_GAP);
      expect(close, close.map((p) => `${p.a} vs ${p.b} gap ${p.gap}`).join("; ")).toEqual([]);
      // The checkbox tap target is the 44 px label. The input inside it stays 22 px.
      expect(found.labelGaps.every((g) => g >= MIN_GAP)).toBe(true);
      const small = found.sizes.filter((s) => s.w < 43.5 || s.h < 43.5);
      expect(small, small.map((s) => `${s.label} ${s.w} x ${s.h}`).join("; ")).toEqual([]);
      expect(found.overflow).toBeLessThanOrEqual(1);
    });
  }
});
