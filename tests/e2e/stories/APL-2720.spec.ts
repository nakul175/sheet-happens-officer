// APL-2720 story spec. Trash says how many days are left. Playwright (playwright.config.ts); npm test skips it (vitest.config.mts).
// AC1: a task deleted just now reads "30 days left" in the Time left cell. AC2: the header stays "Time left", the order is
// deletedAt newest first, Restore works for a Leader and is hidden once the project is archived, and an Editor and a Viewer
// see the cell but no Restore. Each case runs at 1280x800 and 390x844.
// The other ages (29, 2, 1 and 0 days left) are not here: there is no API to age a Trash row, and this spec writes no database.
// They are checked in tests/trash-days-left-aging.test.ts (listTrash at Pam's seven ages, clock moved, npm test) and the text
// for each daysLeft value in tests/trash-days-left.test.tsx.
// Accounts: a CI shard passes SHARD_* and PEER_* (with SHARD_ROLE / PEER_ROLE), as staging-e2e.yml does; otherwise
// SHO_ADMIN_* (a Super Admin) and SHO_MEMBER_* (a plain Member). Skipped unless SHO_QA_PASS is set. Production hosts are refused.
// ZZ-TEST names; every project this file creates is archived through the API, and the Member is taken off it.
import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

const PRODUCTION = new Set(["sheethappensofficer.com", "www.sheethappensofficer.com", "app.sheethappensofficer.com", "168.144.144.69"]);
const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const zz = (label: string) => `${process.env.ZZ_PREFIX || "ZZ-TEST"} ${label} ${RUN}`;
const HEADERS = ["Item", "Deleted by", "Deleted", "Time left", ""];
const SIZES = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
] as const;

type Role = "ADMIN" | "MEMBER";
type Who = { ctx: BrowserContext; page: Page; req: APIRequestContext; id: string };

const words = (daysLeft: number) => `${daysLeft} day${daysLeft === 1 ? "" : "s"} left`;

/** Same default as playwright.config.ts. */
function origin() {
  return (process.env.BASE_URL || process.env.TASKBOARD_URL || "http://localhost:3100").replace(/\/+$/, "");
}

/** The account a role signs in as: a CI shard's SHARD_* / PEER_* when its role matches, else SHO_ADMIN_* / SHO_MEMBER_*. */
function login(role: Role) {
  for (const k of ["SHARD", "PEER"]) {
    if (process.env[`${k}_ROLE`] === role && process.env[`${k}_EMAIL`] && process.env[`${k}_PASS`]) {
      return { email: process.env[`${k}_EMAIL`]!, password: process.env[`${k}_PASS`]! };
    }
  }
  const k = role === "ADMIN" ? "SHO_ADMIN" : "SHO_MEMBER";
  const email = process.env[`${k}_EMAIL`] ?? "";
  const password = process.env[`${k}_PASS`] ?? "";
  return email && password ? { email, password } : null;
}

test.beforeAll(() => {
  test.skip(!process.env.SHO_QA_PASS, "APL-2720: Set SHO_QA_PASS (the shared password for the nakul17+ accounts).");
  let host = "";
  try { host = new URL(origin()).hostname.toLowerCase().replace(/\.$/, ""); } catch { host = ""; }
  if (PRODUCTION.has(host)) throw new Error(`APL-2720: refusing to run story tests against production (${host}).`);
});

async function signIn(browser: Browser, role: Role): Promise<Who> {
  const account = login(role);
  if (!account) throw new Error(`APL-2720: no ${role} account is set (SHO_${role}_EMAIL / SHO_${role}_PASS).`);
  const ctx = await browser.newContext({ baseURL: origin() });
  const signed = await ctx.request.post("/api/auth/signin", { data: account });
  expect(signed.ok(), `sign in as ${role}`).toBe(true);
  const me = await ctx.request.get("/api/auth/me");
  expect(me.ok()).toBe(true);
  const id = ((await me.json()) as { user: { id: string } }).user.id;
  return { ctx, page: await ctx.newPage(), req: ctx.request, id };
}

const cleanup: (() => Promise<unknown>)[] = [];
test.afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn().catch(() => undefined);
});

async function newProject(admin: Who, label: string) {
  const r = await admin.req.post("/api/projects", { data: { name: zz(label), leaderId: admin.id } });
  expect(r.status()).toBe(201);
  const id = ((await r.json()) as { project: { id: string } }).project.id;
  cleanup.push(() => admin.req.post(`/api/projects/${id}/archive`));
  return id;
}

async function trashItem(who: Who, projectId: string, title: string) {
  const r = await who.req.post(`/api/projects/${projectId}/tasks`, { data: { title } });
  expect(r.status()).toBe(201);
  const id = ((await r.json()) as { task: { id: string } }).task.id;
  expect((await who.req.delete(`/api/tasks/${id}`)).status()).toBe(204);
  return id;
}

async function openTrash(page: Page, projectId: string, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  await page.goto(`/projects/${projectId}/trash`);
}

// Below 600 px the Trash table is stacked (.tbl.stack sets tr and td to display: block), and the browser then drops the
// row/cell roles. So rows and header cells are found by tag and exact text, the same way at both sizes. No class selectors.
/** The Trash row for one item, found by its exact title. */
const row = (page: Page, title: string) => page.locator("tr").filter({ has: page.getByText(title, { exact: true }) });

/** The header cells (hidden on a phone by the stacked layout; their text is still checked). */
const headers = (page: Page) => page.locator("th");

/** The Time left text inside one row. */
const timeLeft = (page: Page, title: string, daysLeft: number) => row(page, title).getByText(words(daysLeft), { exact: true });

for (const size of SIZES) {
  const at = `${size.width}x${size.height}`;

  test(`qa:TC-APL2720-01@v1 @APL-2720 AC1@v1.0 a task deleted just now reads 30 days left at ${at}`, async ({ browser }) => {
    test.info().annotations.push({ type: "qa:TC", description: "qa:TC-APL2720-01@v1" });
    const admin = await signIn(browser, "ADMIN");
    try {
      const projectId = await newProject(admin, `2720 fresh ${at}`);
      const title = zz("fresh");
      await trashItem(admin, projectId, title);
      await openTrash(admin.page, projectId, size);
      const r = row(admin.page, title);
      await expect(r).toHaveCount(1);
      await expect(timeLeft(admin.page, title, 30)).toBeVisible();
    } finally {
      await admin.ctx.close();
    }
  });

  test(`qa:TC-APL2720-02@v1 @APL-2720 AC2@v1.0 keeps the Time left header, newest-first order, and Restore for a Leader at ${at}`, async ({ browser }) => {
    test.info().annotations.push({ type: "qa:TC", description: "qa:TC-APL2720-02@v1" });
    const admin = await signIn(browser, "ADMIN");
    try {
      const projectId = await newProject(admin, `2720 order ${at}`);
      await openTrash(admin.page, projectId, size);
      await expect(admin.page.getByText("Trash is empty.")).toBeVisible();
      await expect(admin.page.getByText("Tasks are kept for 30 days, then removed for good.")).toBeVisible();

      const titles = [zz("oldest"), zz("middle"), zz("newest")];
      const ids: string[] = [];
      for (const title of titles) ids.push(await trashItem(admin, projectId, title));
      await openTrash(admin.page, projectId, size);

      await expect(headers(admin.page)).toHaveText(HEADERS);
      const shown = [...titles].reverse();
      const bodyRows = admin.page.locator("tr").filter({ has: admin.page.getByRole("button", { name: "Restore" }) });
      await expect(bodyRows).toHaveCount(shown.length);
      // Newest first: each row's text names the titles in deletedAt-descending order.
      const order = (await bodyRows.allInnerTexts()).map((text) => shown.findIndex((title) => text.includes(title)));
      expect(order).toEqual(shown.map((_, i) => i));
      for (const title of shown) {
        await expect(timeLeft(admin.page, title, 30)).toBeVisible();
      }

      const newest = row(admin.page, shown[0]);
      await newest.getByRole("button", { name: "Restore" }).click();
      await expect.poll(async () => (await admin.req.get(`/api/tasks/${ids[2]}`)).status()).toBe(200);
      await expect(newest).toHaveCount(0);
      await expect(admin.page.getByRole("button", { name: "Restore" })).toHaveCount(shown.length - 1);

      expect((await admin.req.post(`/api/projects/${projectId}/archive`)).status()).toBe(200);
      await admin.page.reload();
      await expect(headers(admin.page)).toHaveText(HEADERS);
      await expect(admin.page.getByRole("button", { name: "Restore" })).toHaveCount(0);
      await expect(timeLeft(admin.page, shown[1], 30)).toBeVisible();
    } finally {
      await admin.ctx.close();
    }
  });

  test(`qa:TC-APL2720-02@v1 @APL-2720 AC2@v1.0 an Editor and a Viewer read Time left but get no Restore at ${at}`, async ({ browser }) => {
    test.info().annotations.push({ type: "qa:TC", description: "qa:TC-APL2720-02@v1" });
    const admin = await signIn(browser, "ADMIN");
    const member = await signIn(browser, "MEMBER");
    try {
      const projectId = await newProject(admin, `2720 access ${at}`);
      expect((await admin.req.post(`/api/projects/${projectId}/members`, { data: { userId: member.id, role: "EDITOR" } })).status()).toBe(201);
      cleanup.push(() => admin.req.delete(`/api/projects/${projectId}/members/${member.id}?handoverTo=${admin.id}`));
      const title = zz("seen");
      const id = await trashItem(admin, projectId, title);
      for (const role of ["EDITOR", "VIEWER"] as const) {
        if (role === "VIEWER") {
          expect((await admin.req.patch(`/api/projects/${projectId}/members/${member.id}`, { data: { role } })).status()).toBe(200);
        }
        await openTrash(member.page, projectId, size);
        await expect(timeLeft(member.page, title, 30)).toBeVisible();
        await expect(headers(member.page)).toHaveText(HEADERS);
        await expect(member.page.getByRole("button", { name: "Restore" })).toHaveCount(0);
        expect((await member.req.post(`/api/tasks/${id}/restore`)).status(), role).toBe(403);
      }
    } finally {
      await member.ctx.close();
      await admin.ctx.close();
    }
  });
}
