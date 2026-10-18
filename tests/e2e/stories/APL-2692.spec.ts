// APL-2692 (APL-2536 AC5): at 390px the organisation page and the Accounts list
// do not scroll the document sideways. AC v1.1 allows the table to scroll inside
// its own region when that region stays in the page and Tab can reach it.
// At 1280 the columns sit where they did before the wrapper change.
// Pam qa:TC: none on the issue. Names use ZZ-TEST and are archived afterwards.
import type { Page } from "@playwright/test";
import { test, expect, zz } from "../support";
import type { Who } from "../g2";
import { pipelines } from "../helpers/deal-board";
import { createDeal, createOrg, dealBody, type Later } from "../helpers/claude-a";

const PHONE = { width: 390, height: 844 };
const DESK = { width: 1280, height: 800 };

type Box = {
  label: string | null;
  role: string | null;
  tab: string | null;
  cls: string;
  extra: number;
  right: number;
  left: number;
  width: number;
  height: number;
};

type Measure = { innerWidth: number; scrollWidth: number; clientWidth: number; boxes: Box[] };

async function seed(admin: Who, later: Later, label: string) {
  const org = await createOrg(admin, later, `${label} org`, { kind: "Ministry" });
  const pipes = await pipelines(admin.api);
  const deal = await createDeal(admin, later, dealBody({
    name: zz(`${label} deal`), organisationId: org.id, pipelineId: pipes.pro.id, leaderId: admin.user.id,
  }));
  return { org, deal };
}

async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const de = document.documentElement;
    const boxes: Box[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const ox = getComputedStyle(el).overflowX;
      if (ox !== "auto" && ox !== "scroll") continue;
      const extra = el.scrollWidth - el.clientWidth;
      if (extra <= 1) continue;
      const r = el.getBoundingClientRect();
      boxes.push({
        label: el.getAttribute("aria-label"),
        role: el.getAttribute("role"),
        tab: el.getAttribute("tabindex"),
        cls: typeof el.className === "string" ? el.className : "",
        extra,
        right: r.right,
        left: r.left,
        width: r.width,
        height: r.height,
      });
    }
    return { innerWidth: window.innerWidth, scrollWidth: de.scrollWidth, clientWidth: de.clientWidth, boxes };
  });
}

/** AC1 and AC v1.1: the document itself stays within the viewport. */
function documentFits(m: Measure, where: string) {
  expect(m.scrollWidth - m.clientWidth, `${where} document scrollWidth - clientWidth`).toBeLessThanOrEqual(1);
  expect(m.scrollWidth, `${where} document scrollWidth`).toBeLessThanOrEqual(m.innerWidth + 1);
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

function expectRegion(m: Measure, label: string) {
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

test.describe("APL-2692", { tag: "@APL-2692" }, () => {
  test.describe.configure({ timeout: 120_000 });

  test("AC1: at 390x844 the document does not scroll sideways", { tag: ["@APL-2692", "@AC1"] }, async ({ admin, later }) => {
    const { org, deal } = await seed(admin, later, "ac1");
    await admin.page.setViewportSize(PHONE);

    await admin.page.goto(`/accounts?q=${encodeURIComponent(org.name)}`);
    await expect(admin.page.getByRole("heading", { name: "Accounts" })).toBeVisible();
    await expect(admin.page.getByLabel("Search organisations")).toHaveValue(org.name);
    await expect(admin.page.getByRole("link", { name: org.name })).toBeVisible();
    documentFits(await measure(admin.page), "/accounts?q=");

    await admin.page.goto(`/accounts/${org.id}`);
    await expect(admin.page.getByRole("heading", { name: org.name })).toBeVisible();
    await expect(admin.page.getByRole("link", { name: deal.name })).toBeVisible();
    documentFits(await measure(admin.page), "/accounts/{id}");
  });

  test("AC2: the table scroller stays inside the page and Tab then ArrowRight moves it", { tag: ["@APL-2692", "@AC2"] }, async ({ admin, later }) => {
    const { org, deal } = await seed(admin, later, "ac2");
    await admin.page.setViewportSize(PHONE);

    await admin.page.goto(`/accounts?q=${encodeURIComponent(org.name)}`);
    await expect(admin.page.getByRole("link", { name: org.name })).toBeVisible();
    const accounts = await measure(admin.page);
    documentFits(accounts, "/accounts?q=");
    expectRegion(accounts, "Accounts");
    await expect(admin.page.getByRole("region", { name: "Accounts" })).toBeVisible();
    await tabToRegion(admin.page, "Accounts");
    const accountsOutline = await focusOutline(admin.page);
    expect(accountsOutline?.style).toBe("solid");
    expect(accountsOutline?.width).toBe("2px");
    expect(accountsOutline?.offset).toBe("2px");
    expect(accountsOutline?.color).toBe(accountsOutline?.gold);
    await arrowScrolls(admin.page);

    await admin.page.goto(`/accounts/${org.id}`);
    await expect(admin.page.getByRole("link", { name: deal.name })).toBeVisible();
    const deals = await measure(admin.page);
    documentFits(deals, "/accounts/{id}");
    expectRegion(deals, "Open deals");
    await expect(admin.page.getByRole("region", { name: "Open deals" })).toBeVisible();
    await tabToRegion(admin.page, "Open deals");
    const dealsOutline = await focusOutline(admin.page);
    expect(dealsOutline?.style).toBe("solid");
    expect(dealsOutline?.width).toBe("2px");
    expect(dealsOutline?.offset).toBe("2px");
    expect(dealsOutline?.color).toBe(dealsOutline?.gold);
    await arrowScrolls(admin.page);
  });

  test("AC3: at 1280x800 the columns sit where they did before this change", { tag: ["@APL-2692", "@AC3"] }, async ({ admin, later }) => {
    const { org, deal } = await seed(admin, later, "ac3");
    const cases = [
      {
        path: `/accounts?q=${encodeURIComponent(org.name)}`,
        heading: "Accounts",
        link: org.name,
        headers: ["Name", "Kind", "Country", "Under", "Open deals"],
      },
      {
        path: `/accounts/${org.id}`,
        heading: org.name,
        link: deal.name,
        headers: ["Deal", "Role", "Stage", "Leader"],
      },
    ];
    await admin.page.setViewportSize(DESK);
    for (const c of cases) {
      await admin.page.goto(c.path);
      await expect(admin.page.getByRole("heading", { name: c.heading })).toBeVisible();
      await expect(admin.page.getByRole("link", { name: c.link })).toBeVisible();
      const layout = await admin.page.evaluate(() => {
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
          scrollWidth: de.scrollWidth,
          clientWidth: de.clientWidth,
          innerWidth: window.innerWidth,
          display: table ? getComputedStyle(table).display : "",
          headers: headers(),
          overflowing: overflowing(),
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
      expect(layout.now.scrollWidth - layout.now.clientWidth, c.path).toBeLessThanOrEqual(1);
      expect(layout.then.scrollWidth - layout.then.clientWidth, c.path).toBeLessThanOrEqual(1);
      expect(layout.now.scrollWidth, c.path).toBeLessThanOrEqual(layout.now.innerWidth + 1);
      expect(layout.then.scrollWidth, c.path).toBeLessThanOrEqual(layout.then.innerWidth + 1);
      expect(layout.now.overflowing, c.path).toEqual([]);
      expect(layout.then.overflowing, c.path).toEqual([]);
      expect(layout.now.display, c.path).toBe("table");
      expect(layout.then.display, c.path).toBe("table");
      expect(layout.now.headers.map((h) => h.text), c.path).toEqual(c.headers);
      expect(layout.now.headers.map((h) => h.text), c.path).toEqual(layout.then.headers.map((h) => h.text));
      expect(layout.now.headers.length, c.path).toBeGreaterThan(0);
      for (let i = 0; i < layout.now.headers.length; i++) {
        expect(Math.abs(layout.now.headers[i].x - layout.then.headers[i].x), `${c.path} ${layout.now.headers[i].text} x`).toBeLessThanOrEqual(1);
        expect(Math.abs(layout.now.headers[i].w - layout.then.headers[i].w), `${c.path} ${layout.now.headers[i].text} width`).toBeLessThanOrEqual(1);
      }
    }
  });
});
