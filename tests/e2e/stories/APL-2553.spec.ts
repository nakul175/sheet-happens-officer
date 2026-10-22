// SHO-US-22.5 Lists and tables on phones (APL-2553). Epic SHO-E22.
// Runs against staging. Data: ZZ-TEST projects (one with a 96-character name) and one ZZ-TEST person with a 41-character surname
// (added at an address on the reserved .invalid domain, so no real inbox is mailed; deactivated afterwards).
import { test, expect, zz, RUN, login, BASE_URL } from "../support";
import type { Browser } from "@playwright/test";

async function phone(browser: Browser, width: number, height = 800, touch = true, who: "admin" | "member" = "admin") {
  const email = who === "admin" ? login("ADMIN").email : login("MEMBER").email;
  const password = who === "admin" ? login("ADMIN").password : login("MEMBER").password;
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    httpCredentials: process.env.STAGING_USER ? { username: process.env.STAGING_USER, password: process.env.STAGING_PASS ?? "" } : undefined,
    viewport: { width, height }, hasTouch: touch, isMobile: touch,
  });
  const r = await ctx.request.post("/api/auth/signin", { data: { email, password } });
  expect(r.ok(), `sign in as ${who}`).toBe(true);
  return ctx;
}


let projectId = "";
test.beforeEach(async ({ admin, later }) => {
  const r = await admin.api.post("/api/projects", { name: zz("22.5 tables"), leaderId: admin.user.id });
  expect(r.status).toBe(201);
  projectId = r.json.project.id;
  later(() => admin.api.post(`/api/projects/${projectId}/archive`));
});

test("AC1: on Team, Audit, Usage and Members under 600 px every value has a visible label", async ({ browser }) => {
  const ctx = await phone(browser, 390, 844);
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}/members`, { waitUntil: "load" });
  await expect(page.locator("main .item .vlab").first()).toBeVisible(); // Members shows each role under a visible "Role" label
  await expect(page.locator("main .item .vlab").first()).toHaveText("Role");
  for (const path of ["/team", "/audit", "/usage"]) {
    await page.goto(path, { waitUntil: "load" });
    await page.waitForFunction(() => !document.querySelector(".skel, .skel-wrap"), undefined, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(300);
    const unlabelled = await page.evaluate(() => {
      const out: string[] = [];
      for (const td of document.querySelectorAll<HTMLElement>("main.content table td, main table td")) {
        const cs = getComputedStyle(td);
        if (cs.display === "none" || !td.textContent?.trim()) continue;
        const b = getComputedStyle(td, "::before").content;
        if (!td.getAttribute("data-label") || b === "none" || b === '""') out.push(td.textContent!.trim().slice(0, 30));
      }
      return out;
    });
    expect(unlabelled, `${path}: cells with no visible label`).toEqual([]);
    const rows = await page.locator("main table td").count();
    // Usage is empty until the concierge has been used on that server; the label rule is then checked on the other three screens.
    if (path !== "/usage") expect(rows, `${path} has rows to check`).toBeGreaterThan(0);
    else test.info().annotations.push({ type: "note", description: `/usage had ${rows} table cells on this server` });
  }
  await ctx.close();
});

test("AC2: a 96-character project name takes at most 2 lines at 320 px, and Add task and List/Board are on screen", async ({ browser, admin, later }) => {
  const name = zz("22.5 ").padEnd(96, "x").replace(/x/g, (m, i) => (i % 20 === 19 ? " " : "w"));
  expect(name.length).toBe(96);
  const r = await admin.api.post("/api/projects", { name, leaderId: admin.user.id });
  expect(r.status).toBe(201);
  const id = r.json.project.id;
  later(() => admin.api.post(`/api/projects/${id}/archive`));
  const ctx = await phone(browser, 320, 700);
  const page = await ctx.newPage();
  await page.goto(`/projects/${id}`, { waitUntil: "load" });
  const h1 = page.locator("h1.pt", { hasText: "ZZ-TEST" });
  await h1.waitFor({ timeout: 30000 });
  // Count the lines the title text itself occupies (the breadcrumb link sits in the same heading and is excluded).
  const lines = await h1.evaluate((e) => {
    const box = e.getBoundingClientRect();
    const tops = new Set<number>();
    const walk = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if ((n.parentElement as HTMLElement).closest("a")) continue;
      const r = document.createRange(); r.selectNodeContents(n);
      for (const q of Array.from(r.getClientRects())) if (q.width > 0 && q.bottom <= box.bottom + 1 && q.top >= box.top - 1) tops.add(Math.round(q.top / 4));
    }
    return tops.size;
  });
  expect(lines).toBeLessThanOrEqual(2);
  await expect(page.getByRole("button", { name: /Add task|\+ Add task|New task/ }).first()).toBeInViewport();
  await expect(page.getByRole("tab", { name: "List" })).toBeInViewport();
  await expect(page.getByRole("tab", { name: "Board" })).toBeInViewport();
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw).toBeLessThanOrEqual(m.iw + 1);
  await ctx.close();
});

test("AC3: a 41-character surname wraps or truncates with the full text available and nothing overflows", async ({ browser, admin, later }) => {
  const surname = "Verylongsurnamethatkeepsgoingandgoing".padEnd(41, "g");
  expect(surname.length).toBe(41);
  const email = `zz-test-${RUN}-surname@example.invalid`;
  const r = await admin.api.post("/api/team", { firstName: "ZZ-TEST", lastName: surname, email, role: "MEMBER" });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const pid = r.json.user?.id ?? r.json.person?.id ?? r.json.id;
  later(async () => { if (pid) await admin.api.post(`/api/team/${pid}/deactivate`, { reassign: "leaders" }); });
  const ctx = await phone(browser, 320, 700);
  const page = await ctx.newPage();
  await page.goto("/team", { waitUntil: "load" });
  const link = page.getByRole("link", { name: new RegExp(surname) });
  await expect(link.first()).toBeVisible({ timeout: 30000 });
  await expect(link.first()).toContainText(surname); // the full text is in the page
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  expect(m.sw).toBeLessThanOrEqual(m.iw + 1);
  await ctx.close();
});

test("AC4: at 600 px and wider a wide table scrolls inside its own box, not the page", async ({ browser }) => {
  for (const w of [600, 768]) {
    const ctx = await phone(browser, w, 900);
    const page = await ctx.newPage();
    for (const path of ["/team", "/audit"]) {
      await page.goto(path, { waitUntil: "load" });
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(m.sw, `${path} at ${w}px: the page itself scrolls sideways`).toBeLessThanOrEqual(m.iw + 1);
    }
    await ctx.close();
  }
});

test("Prohibited: no column is dropped on phones (Team still has Name, Email and Role)", async ({ browser }) => {
  const ctx = await phone(browser, 360, 800);
  const page = await ctx.newPage();
  await page.goto("/team", { waitUntil: "load" });
  await page.locator("main table td[data-label]").first().waitFor();
  const labels = await page.$$eval("main table td[data-label]", (tds) => Array.from(new Set(tds.map((t) => t.getAttribute("data-label")))));
  for (const l of ["Name", "Email", "Role"]) expect(labels).toContain(l);
  await ctx.close();
});
