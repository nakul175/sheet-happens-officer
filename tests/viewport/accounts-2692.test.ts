// APL-2692 (APL-2536 AC5): the organisation page and the Accounts list must not
// scroll the document sideways at 390x844. A wide table may scroll inside its
// own region, and that region has to be reached with Tab. Desktop stays one row.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { BASE, istDate, PW, SUPER_EMAIL, superAdmin, type Account } from "../helpers";

const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 800 };

let browser: Browser;
let root: Account | undefined;
let orgId = "";
let dealId = "";
let orgName = "";
let dealName = "";

beforeAll(async () => {
  if (!/^(localhost|127\.0\.0\.1)$/.test(new URL(BASE).hostname)) throw new Error(`Refusing to run against ${BASE}: use a local server with a test database.`);
  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  root = await superAdmin();
  const stamp = Date.now();
  orgName = `ZZ-TEST ${stamp} narrow org mve8ij02tlmf`;
  dealName = `ZZ-TEST ${stamp} narrow deal mve8ij02tlmf`;
  const org = await root.c.post("/api/orgs", { name: orgName, kind: "ZZ-TEST" });
  expect(org.status, JSON.stringify(org.json)).toBe(201);
  orgId = org.json.organisation.id as string;
  const pipes = (await root.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
  const deal = await root.c.post("/api/deals", {
    name: dealName, organisationId: orgId, pipelineId: pipes.find((x) => x.key === "DEAL_PROACTIVE")!.id, leaderId: root.id,
    whyPursue: "ZZ-TEST pursue this organisation", nextStep: { title: "ZZ-TEST call the buyer", dueDate: istDate(3) },
  });
  expect(deal.status, JSON.stringify(deal.json)).toBe(201);
  dealId = deal.json.deal.id as string;
}, 60000);

afterAll(async () => {
  try {
    // Archive only the organisation and deal this file created. Nothing else is touched.
    if (root && dealId) {
      const deal = await root.c.post(`/api/projects/${dealId}/archive`);
      expect([200, 409]).toContain(deal.status);
    }
    if (root && orgId) {
      const org = await root.c.post(`/api/orgs/${orgId}/archive`, { archive: true });
      expect([200, 409]).toContain(org.status);
      const left = await root.c.get(`/api/orgs?q=${encodeURIComponent(orgName)}`);
      const names = (left.json?.organisations ?? []) as { id: string; name: string }[];
      expect(names.filter((o) => o.id === orgId)).toEqual([]);
    }
  } finally {
    await browser?.close();
  }
});

async function openAt(viewport: { width: number; height: number }, path: string, ready: string) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, baseURL: BASE });
  const signed = await ctx.request.post("/api/auth/signin", { data: { email: SUPER_EMAIL, password: PW } });
  expect(signed.ok(), "sign in").toBe(true);
  const page = await ctx.newPage();
  await page.goto(path, { waitUntil: "load" });
  await page.waitForSelector(ready, { timeout: 15000 });
  return page;
}

type Box = { label: string | null; role: string | null; tab: string | null; cls: string; extra: number; right: number; left: number; width: number; height: number };

function scrollers(): { innerWidth: number; scrollWidth: number; boxes: Box[] } {
  const de = document.documentElement;
  const boxes: Box[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("body *")) {
    const ox = getComputedStyle(el).overflowX;
    if (ox !== "auto" && ox !== "scroll") continue;
    const extra = el.scrollWidth - el.clientWidth;
    if (extra <= 1) continue;
    const r = el.getBoundingClientRect();
    boxes.push({
      label: el.getAttribute("aria-label"), role: el.getAttribute("role"), tab: el.getAttribute("tabindex"),
      cls: typeof el.className === "string" ? el.className : "", extra,
      right: r.right, left: r.left, width: r.width, height: r.height,
    });
  }
  return { innerWidth: window.innerWidth, scrollWidth: de.scrollWidth, boxes };
}

function pageFits(m: { scrollWidth: number; innerWidth: number }) {
  expect(m.scrollWidth, "documentElement.scrollWidth").toBeLessThanOrEqual(m.innerWidth + 1);
}

/** Tab from the top of the page until the named region is focused. Does not call focus() on it. */
async function tabToRegion(page: Page, label: string) {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const hit = await page.evaluate((want) => {
      const el = document.activeElement;
      return el instanceof HTMLElement && el.classList.contains("acct-scroll") && el.getAttribute("aria-label") === want;
    }, label);
    if (hit) return;
  }
  const stuck = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el ? `${el.tagName} ${el.className} ${el.getAttribute("aria-label") ?? ""}`.trim() : "none";
  });
  throw new Error(`Tab never reached the ${label} region. Last focus: ${stuck}`);
}

async function focusOutline(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement)) return null;
    const s = getComputedStyle(el);
    const probe = document.createElement("span");
    probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--gold").trim();
    document.body.appendChild(probe);
    const gold = getComputedStyle(probe).color;
    probe.remove();
    return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, color: s.outlineColor, gold };
  });
}

async function arrowScrolls(page: Page) {
  await page.keyboard.down("ArrowRight");
  try {
    await page.waitForFunction(() => {
      const el = document.activeElement;
      return el instanceof HTMLElement && el.classList.contains("acct-scroll") && el.scrollLeft > 0;
    }, undefined, { timeout: 3000 });
  } finally {
    await page.keyboard.up("ArrowRight");
  }
  expect(await page.evaluate(() => (document.activeElement as HTMLElement).scrollLeft)).toBeGreaterThan(0);
}

function expectRegion(m: { innerWidth: number; boxes: Box[] }, label: string) {
  expect(m.boxes.map((b) => b.cls), "the table wrapper is the element that scrolls").toEqual(["acct-scroll"]);
  const box = m.boxes[0];
  expect(box.label).toBe(label);
  expect(box.role).toBe("region");
  expect(box.tab).toBe("0");
  expect(box.extra).toBeGreaterThan(1);
  expect(box.left).toBeGreaterThanOrEqual(-1);
  expect(box.right).toBeLessThanOrEqual(m.innerWidth + 1);
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
}

describe("@APL-2692 accounts sideways scroll", () => {
  it("@APL-2692 @AC1 @AC2 @TC1 /accounts?q= at 390x844 fits, and Tab then ArrowRight scrolls the Accounts region", async () => {
    const page = await openAt(PHONE, `/accounts?q=${encodeURIComponent(orgName)}`, `a[href="/accounts/${orgId}"]`);
    try {
      expect(await page.locator('input[aria-label="Search organisations"]').inputValue()).toBe(orgName);
      const m = await page.evaluate(scrollers);
      pageFits(m);
      expectRegion(m, "Accounts");
      await tabToRegion(page, "Accounts");
      const outline = await focusOutline(page);
      expect(outline?.style).toBe("solid");
      expect(outline?.width).toBe("2px");
      expect(outline?.offset).toBe("2px");
      expect(outline?.color).toBe(outline?.gold);
      await arrowScrolls(page);
    } finally { await page.context().close(); }
  });

  it("@APL-2692 @AC1 @AC2 @TC2 /accounts/{id} at 390x844 fits, and Tab then ArrowRight scrolls the Open deals region", async () => {
    const page = await openAt(PHONE, `/accounts/${orgId}`, `a[href="/projects/${dealId}"]`);
    try {
      const m = await page.evaluate(scrollers);
      pageFits(m);
      expectRegion(m, "Open deals");
      await tabToRegion(page, "Open deals");
      const outline = await focusOutline(page);
      expect(outline?.style).toBe("solid");
      expect(outline?.width).toBe("2px");
      expect(outline?.offset).toBe("2px");
      expect(outline?.color).toBe(outline?.gold);
      await arrowScrolls(page);
    } finally { await page.context().close(); }
  });

  it("@APL-2692 @AC3 @TC3 at 1280x800 the columns sit where they did before this change", async () => {
    const cases = [
      { path: `/accounts?q=${encodeURIComponent(orgName)}`, ready: `a[href="/accounts/${orgId}"]`, headers: ["Name", "Kind", "Country", "Under", "Open deals"] },
      { path: `/accounts/${orgId}`, ready: `a[href="/projects/${dealId}"]`, headers: ["Deal", "Role", "Stage", "Leader"] },
    ];
    for (const c of cases) {
      const page = await openAt(DESK, c.path, c.ready);
      try {
        const layout = await page.evaluate(() => {
          const de = document.documentElement;
          const wrap = document.querySelector<HTMLElement>(".acct-scroll");
          const table = wrap?.querySelector<HTMLElement>("table.tbl") ?? null;
          const headers = () => [...(table?.querySelectorAll("th") ?? [])].map((th) => {
            const r = th.getBoundingClientRect();
            return { text: (th.textContent || "").trim(), x: Math.round(r.x), w: Math.round(r.width) };
          });
          const overflowing = () => [...document.querySelectorAll<HTMLElement>("body *")].filter((el) => {
            const ox = getComputedStyle(el).overflowX;
            return (ox === "auto" || ox === "scroll") && el.scrollWidth - el.clientWidth > 1;
          }).map((el) => (typeof el.className === "string" ? el.className : el.tagName));
          const shot = () => ({
            scrollWidth: de.scrollWidth, innerWidth: window.innerWidth,
            display: table ? getComputedStyle(table).display : "",
            headers: headers(), overflowing: overflowing(),
          });
          const now = shot();
          // The previous wrapper was only overflow-x:auto. Drop the new class so the columns can be compared in place.
          if (wrap) {
            wrap.classList.remove("acct-scroll");
            wrap.style.overflowX = "auto";
            wrap.style.maxWidth = "";
            wrap.style.minWidth = "";
          }
          const then = shot();
          return { now, then };
        });
        pageFits(layout.now);
        pageFits(layout.then);
        expect(layout.now.overflowing, c.path).toEqual([]);
        expect(layout.then.overflowing, c.path).toEqual([]);
        expect(layout.now.display, c.path).toBe("table");
        expect(layout.then.display, c.path).toBe("table");
        expect(layout.now.headers.map((h) => h.text), c.path).toEqual(c.headers);
        expect(layout.now.headers.map((h) => h.text), c.path).toEqual(layout.then.headers.map((h) => h.text));
        expect(layout.now.headers.length, c.path).toBeGreaterThan(0);
        for (let i = 0; i < layout.now.headers.length; i++) {
          expect(Math.abs(layout.now.headers[i].x - layout.then.headers[i].x), c.path).toBeLessThanOrEqual(1);
          expect(Math.abs(layout.now.headers[i].w - layout.then.headers[i].w), c.path).toBeLessThanOrEqual(1);
        }
      } finally { await page.context().close(); }
    }
  });
});
