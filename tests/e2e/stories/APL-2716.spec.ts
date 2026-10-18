// APL-2716 story. Under CRM_VISIBLE=admins a non-admin's deal notices are one sentence
// with no href. Under all and unset the bell matches main, including a non-member.
// workers=1. Production hosts are refused. Point TASKBOARD_URL at a local server.
// Thrown-away people and projects use ZZ-TEST names and nakul17+ aliases.
// @vitest-environment jsdom
import { existsSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type Page } from "playwright-core";
import { Bell } from "@/app/(app)/Bell";
import { HIDDEN_DEAL_TEXT, listNotifications } from "@/lib/feed";
import { db } from "@/lib/db";
import { account, BASE, istDate, project, PW, superAdmin, type Account } from "../../helpers";

const PRODUCTION = new Set(["sheethappensofficer.com", "www.sheethappensofficer.com", "app.sheethappensofficer.com"]);
for (const raw of [process.env.TASKBOARD_URL, process.env.BASE_URL, process.env.STAGING_URL]) {
  if (!raw) continue;
  let host = "";
  try { host = new URL(raw).hostname.toLowerCase().replace(/\.$/, ""); } catch { host = raw; }
  if (PRODUCTION.has(host)) throw new Error(`Refusing to run story tests against production (${host}).`);
}

const harness = vi.hoisted(() => ({
  api: (async () => ({ ok: true, status: 200, data: { unread: 0, items: [] as Note[], next: null } })) as (
    ...args: unknown[]
  ) => Promise<{ ok: boolean; status: number; data: { unread: number; items: Note[]; next: null } }>,
}));

vi.mock("next/link", async () => {
  const React = await import("react");
  return {
    default: ({ href, children, className, onClick }: { href: string; children?: ReactNode; className?: string; onClick?: (e: { preventDefault: () => void }) => void }) =>
      React.createElement("a", { href, className, onClick }, children),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

vi.mock("@/components/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/api")>();
  return { ...actual, api: (...args: unknown[]) => harness.api(...args) };
});

type Note = { id: string; text: string; href: string | null; read: boolean; createdAt: string };
type BellPage = { unread: number; items: { text: string; href: string | null }[] };

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const DEAL = `ZZ-TEST Acme renewal ${RUN}`;
const TASK = `ZZ-TEST Acme kickoff ${RUN}`;
const PLAIN = `ZZ-TEST Pack the cartons ${RUN}`;
const STAGE = "Proposal";
const WIDTHS = [1280, 390] as const;
const HAS_CHROME = !!chromePath();

const people: Account[] = [];
const projectIds: string[] = [];
let dealId = "";
let kickoffId = "";
let plainId = "";
let plainTaskId = "";
let member: Account;
let outsider: Account;
let orgAdmin: Account;
let browser: Browser | null = null;

const stageText = () => `Someone moved "${DEAL}" to ${STAGE}.`;
const nextText = () => `"${DEAL}" needs a next step.`;
const stalledText = () => `"${DEAL}" has had no activity for 30 days.`;
const taskText = () => `Someone assigned you "${TASK}".`;
const plainText = () => `Someone assigned you "${PLAIN}".`;
const dealHref = () => `/projects/${dealId}`;
const taskHref = () => `/tasks/${kickoffId}`;
const plainHref = () => `/tasks/${plainTaskId}`;

function chromePath() {
  const candidates = [process.env.PW_CHROMIUM, "/usr/bin/google-chrome-stable", "/usr/local/bin/google-chrome", "/usr/bin/google-chrome"];
  return candidates.find((p) => !!p && existsSync(p));
}

async function withMode<T>(mode: "admins" | "all" | "unset", fn: () => Promise<T>) {
  const prev = process.env.CRM_VISIBLE;
  if (mode === "unset") delete process.env.CRM_VISIBLE;
  else process.env.CRM_VISIBLE = mode;
  try { return await fn(); }
  finally {
    if (prev === undefined) delete process.env.CRM_VISIBLE;
    else process.env.CRM_VISIBLE = prev;
  }
}

async function bellOf(who: Account, orgRole: "MEMBER" | "ADMIN", mode: "admins" | "all" | "unset"): Promise<BellPage> {
  return withMode(mode, () => listNotifications({ id: who.id, orgRole, name: who.name }));
}

/** The same check the hidden bell must fail: a deal name, task title, stage, or deal href. */
function assertNoDealLeak(body: string, label: string) {
  expect(body, `${label} deal name`).not.toContain(DEAL);
  expect(body, `${label} partial name`).not.toContain("Acme");
  expect(body, `${label} task title`).not.toContain(TASK);
  expect(body, `${label} stage`).not.toContain(STAGE);
  expect(body, `${label} deal href`).not.toContain(dealHref());
  expect(body, `${label} task href`).not.toContain(taskHref());
}

function httpBell(who: Account) {
  return who.c.get("/api/notifications").then((r) => {
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json as { unread: number; items: { text: string; href: string | null }[] };
  });
}

describe("APL-2716 hidden deal notices", () => {
  beforeAll(async () => {
    const sa = await superAdmin();
    member = await account(`ZZ-TEST member ${RUN}`, `nakul17+zz-2716-${RUN}-member@aplyd.com`);
    outsider = await account(`ZZ-TEST outsider ${RUN}`, `nakul17+zz-2716-${RUN}-outsider@aplyd.com`);
    orgAdmin = await account(`ZZ-TEST admin ${RUN}`, `nakul17+zz-2716-${RUN}-admin@aplyd.com`);
    expect((await sa.c.patch(`/api/team/${orgAdmin.id}`, { orgRole: "ADMIN" })).status).toBe(200);
    people.push(member, outsider, orgAdmin);

    const pipes = await member.c.get("/api/deals/pipelines");
    expect(pipes.status, JSON.stringify(pipes.json)).toBe(200);
    const pipe = (pipes.json.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
    expect(pipe?.id).toBeTruthy();
    const org = await member.c.post("/api/orgs", { name: `ZZ-TEST Buyer ${RUN}` });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    const made = await member.c.post("/api/deals", {
      name: DEAL, organisationId: org.json.organisation.id, pipelineId: pipe!.id, leaderId: member.id,
      whyPursue: RUN, nextStep: { title: `Send the pack ${RUN}`, dueDate: istDate(2) },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    dealId = made.json.deal.id as string;
    projectIds.push(dealId);
    const plain = await project(member, member);
    plainId = plain.id;
    projectIds.push(plainId);
    kickoffId = `kickoff-${RUN}`;
    plainTaskId = `plain-${RUN}`;

    const ids = [member.id, outsider.id, orgAdmin.id];
    await db.notification.deleteMany({ where: { recipientId: { in: ids } } });
    await db.notification.createMany({
      data: ids.flatMap((recipientId) => [
        { recipientId, type: "DEAL_STAGE_CHANGED", projectId: dealId, data: { project: DEAL, stage: STAGE } },
        { recipientId, type: "DEAL_NEEDS_NEXT_STEP", projectId: dealId, data: { project: DEAL } },
        { recipientId, type: "DEAL_STALLED", projectId: dealId, data: { project: DEAL } },
        { recipientId, type: "TASK_ASSIGNED", projectId: dealId, taskId: kickoffId, data: { title: TASK, project: DEAL } },
        { recipientId, type: "TASK_ASSIGNED", projectId: plainId, taskId: plainTaskId, data: { title: PLAIN, project: `ZZ-TEST Packing ${RUN}` } },
      ]),
    });

    try {
      browser = await chromium.launch({
        executablePath: chromePath(),
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        timeout: 15_000,
      });
    } catch { browser = null; }
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    const sa = await superAdmin();
    for (const id of projectIds) {
      await sa.c.post(`/api/projects/${id}/members`, { userId: sa.id, role: "EDITOR" });
      await sa.c.post(`/api/projects/${id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" });
      await sa.c.post(`/api/projects/${id}/archive`);
    }
    for (const who of people) {
      if (who.id === sa.id) continue;
      await sa.c.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
    }
  });

  it("qa:TC-APL2716-3abdb652@v1 DEAL_STAGE_CHANGED is the generic sentence for a non-admin under admins, and the admin sentence stays", async () => {
    for (const who of [member, outsider]) {
      const hidden = await bellOf(who, "MEMBER", "admins");
      const row = hidden.items.find((item) => item.text === HIDDEN_DEAL_TEXT || item.text === stageText());
      expect(row).toEqual({ text: HIDDEN_DEAL_TEXT, href: null });
      assertNoDealLeak(JSON.stringify(hidden), "admins member");
    }
    const seen = await bellOf(orgAdmin, "ADMIN", "admins");
    expect(seen.items).toContainEqual({ text: stageText(), href: dealHref() });
  });

  it("qa:TC-APL2716-85782555@v1 DEAL_NEEDS_NEXT_STEP is generic for a non-admin under admins, and the admin sentence stays", async () => {
    const hidden = await bellOf(outsider, "MEMBER", "admins");
    expect(hidden.items.filter((item) => item.href === null).length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(hidden)).not.toContain("needs a next step");
    const seen = await bellOf(orgAdmin, "ADMIN", "admins");
    expect(seen.items).toContainEqual({ text: nextText(), href: dealHref() });
  });

  it("qa:TC-APL2716-fcc1861b@v1 DEAL_STALLED is generic for a non-admin under admins, and the admin sentence stays", async () => {
    const hidden = await bellOf(outsider, "MEMBER", "admins");
    expect(JSON.stringify(hidden)).not.toContain("no activity");
    const seen = await bellOf(orgAdmin, "ADMIN", "admins");
    expect(seen.items).toContainEqual({ text: stalledText(), href: dealHref() });
  });

  it("qa:TC-APL2716-a8042ed1@v1 all and unset leave the bell unchanged for an admin, an on-deal member and a non-member", async () => {
    for (const mode of ["all", "unset"] as const) {
      for (const [who, role] of [[orgAdmin, "ADMIN"], [member, "MEMBER"], [outsider, "MEMBER"]] as const) {
        const page = await bellOf(who, role, mode);
        const label = `${mode} ${role}`;
        expect(page.items, label).toContainEqual({ text: stageText(), href: dealHref() });
        expect(page.items, label).toContainEqual({ text: nextText(), href: dealHref() });
        expect(page.items, label).toContainEqual({ text: stalledText(), href: dealHref() });
        expect(page.items, label).toContainEqual({ text: taskText(), href: taskHref() });
        expect(page.unread, label).toBe(5);
      }
    }
    // The app server in CI leaves CRM_VISIBLE unset, which is this same all behaviour.
    for (const who of [orgAdmin, member, outsider]) {
      const live = await httpBell(who);
      expect(live.items, who.email).toContainEqual({ text: stageText(), href: dealHref() });
      expect(live.items, who.email).toContainEqual({ text: taskText(), href: taskHref() });
    }
  });

  it("qa:TC-APL2716-4811612d@v1 a non-deal task notice is unchanged in admins, all and unset", async () => {
    for (const mode of ["admins", "all", "unset"] as const) {
      for (const [who, role] of [[orgAdmin, "ADMIN"], [member, "MEMBER"], [outsider, "MEMBER"]] as const) {
        const page = await bellOf(who, role, mode);
        expect(page.items, `${mode} ${role}`).toContainEqual({ text: plainText(), href: plainHref() });
      }
    }
    const live = await httpBell(outsider);
    expect(live.items).toContainEqual({ text: plainText(), href: plainHref() });
  });

  it("qa:TC-APL2716-d2ec503b@v1 the hidden bell fails when the deal name, task title, stage or deal href appears", async () => {
    const hidden = await bellOf(outsider, "MEMBER", "admins");
    const body = JSON.stringify(hidden);
    assertNoDealLeak(body, "admins non-member");
    expect(hidden.items.filter((item) => item.text !== plainText()).every((item) => item.text === HIDDEN_DEAL_TEXT && item.href === null)).toBe(true);
    const leaked = body.replaceAll(HIDDEN_DEAL_TEXT, stageText());
    expect(leaked).toContain(DEAL);
    expect(() => assertNoDealLeak(leaked, "leaked")).toThrow();
  });

  describe("bell on screen", () => {
    const hiddenNotes = (): Note[] => [
      { id: "stage", text: HIDDEN_DEAL_TEXT, href: null, read: false, createdAt: new Date().toISOString() },
      { id: "next", text: HIDDEN_DEAL_TEXT, href: null, read: false, createdAt: new Date().toISOString() },
      { id: "stalled", text: HIDDEN_DEAL_TEXT, href: null, read: false, createdAt: new Date().toISOString() },
      { id: "kickoff", text: HIDDEN_DEAL_TEXT, href: null, read: false, createdAt: new Date().toISOString() },
      { id: "plain", text: plainText(), href: plainHref(), read: false, createdAt: new Date().toISOString() },
    ];
    const namedNotes = (): Note[] => [
      { id: "stage", text: stageText(), href: dealHref(), read: false, createdAt: new Date().toISOString() },
      { id: "next", text: nextText(), href: dealHref(), read: false, createdAt: new Date().toISOString() },
      { id: "stalled", text: stalledText(), href: dealHref(), read: false, createdAt: new Date().toISOString() },
      { id: "kickoff", text: taskText(), href: taskHref(), read: false, createdAt: new Date().toISOString() },
      { id: "plain", text: plainText(), href: plainHref(), read: false, createdAt: new Date().toISOString() },
    ];

    let root: Root | undefined;
    async function openPanel(notes: Note[], width: number) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      harness.api = async () => ({ ok: true, status: 200, data: { unread: notes.length, items: notes, next: null } });
      document.body.replaceChildren();
      const host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => { root!.render(createElement(Bell)); });
      for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
      const button = document.querySelector("button.bell") as HTMLButtonElement;
      expect(button, "bell button").toBeTruthy();
      await act(async () => { button.click(); });
      for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
      const panel = document.querySelector("[aria-label='Notifications']");
      expect(panel, "notifications panel").toBeTruthy();
      return panel!;
    }

    afterAll(() => { act(() => root?.unmount()); });

    it.each(WIDTHS)("qa:TC-APL2716-3abdb652@v1 qa:TC-APL2716-85782555@v1 qa:TC-APL2716-fcc1861b@v1 the hidden bell at %i px is the generic sentence and not a link", async (width) => {
      const panel = await openPanel(hiddenNotes(), width);
      const text = panel.textContent ?? "";
      expect(text).toContain(HIDDEN_DEAL_TEXT);
      expect(text).not.toContain(DEAL);
      expect(text).not.toContain("Acme");
      expect(text).not.toContain(TASK);
      expect(text).not.toContain(STAGE);
      expect(text).not.toContain("needs a next step");
      expect(text).not.toContain("no activity");
      const links = [...panel.querySelectorAll("a")].map((a) => a.getAttribute("href"));
      expect(links.some((href) => href?.includes("/projects/") || href === taskHref())).toBe(false);
      expect(links).toContain(plainHref());
      expect(text).toContain(PLAIN);
    });

    it.each(WIDTHS)("qa:TC-APL2716-a8042ed1@v1 qa:TC-APL2716-4811612d@v1 the named bell at %i px keeps the deal sentence, the task title and the links", async (width) => {
      const panel = await openPanel(namedNotes(), width);
      const text = panel.textContent ?? "";
      expect(text).toContain(stageText());
      expect(text).toContain(nextText());
      expect(text).toContain(stalledText());
      expect(text).toContain(taskText());
      expect(text).toContain(plainText());
      const links = [...panel.querySelectorAll("a")].map((a) => a.getAttribute("href"));
      expect(links).toContain(dealHref());
      expect(links).toContain(taskHref());
      expect(links).toContain(plainHref());
    });
  });

  describe.skipIf(!HAS_CHROME)("bell in the browser", () => {
    async function signedIn(width: number, who: Account) {
      const ctx = await browser!.newContext({ viewport: { width, height: 800 }, baseURL: BASE, hasTouch: width < 600, isMobile: width < 600 });
      const signed = await ctx.request.post("/api/auth/signin", { data: { email: who.email, password: PW } });
      expect(signed.ok()).toBe(true);
      return ctx;
    }

    async function readPanel(page: Page) {
      await page.goto("/", { waitUntil: "load" });
      const bell = page.locator("button.bell");
      await bell.waitFor({ timeout: 15_000 });
      await bell.click();
      const panel = page.getByRole("dialog", { name: "Notifications" });
      await panel.waitFor({ state: "visible", timeout: 15_000 });
      return panel;
    }

    it.each(WIDTHS)("qa:TC-APL2716-a8042ed1@v1 the live bell at %i px names the deal for a non-member when CRM_VISIBLE is unset", async (width) => {
      expect(browser, "Chromium").toBeTruthy();
      const ctx = await signedIn(width, outsider);
      const page = await ctx.newPage();
      const panel = await readPanel(page);
      const text = await panel.innerText();
      expect(text).toContain(stageText());
      expect(text).toContain(taskText());
      expect(await panel.locator(`a[href="${dealHref()}"]`).count()).toBeGreaterThan(0);
      expect(await panel.locator(`a[href="${taskHref()}"]`).count()).toBeGreaterThan(0);
      await ctx.close();
    });

    it.each(WIDTHS)("qa:TC-APL2716-3abdb652@v1 the live bell at %i px shows only the generic sentence when the API redacts the deal", async (width) => {
      expect(browser, "Chromium").toBeTruthy();
      const ctx = await signedIn(width, outsider);
      await ctx.route("**/api/notifications**", (route) => {
        if (route.request().method() !== "GET") return route.continue();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            unread: 5,
            next: null,
            items: [
              { id: "stage", text: HIDDEN_DEAL_TEXT, href: null, read: false, createdAt: new Date().toISOString() },
              { id: "next", text: HIDDEN_DEAL_TEXT, href: null, read: false, createdAt: new Date().toISOString() },
              { id: "stalled", text: HIDDEN_DEAL_TEXT, href: null, read: false, createdAt: new Date().toISOString() },
              { id: "kickoff", text: HIDDEN_DEAL_TEXT, href: null, read: false, createdAt: new Date().toISOString() },
              { id: "plain", text: plainText(), href: plainHref(), read: false, createdAt: new Date().toISOString() },
            ],
          }),
        });
      });
      const page = await ctx.newPage();
      const panel = await readPanel(page);
      const text = await panel.innerText();
      expect(text).toContain(HIDDEN_DEAL_TEXT);
      expect(text).not.toContain(DEAL);
      expect(text).not.toContain("Acme");
      expect(text).not.toContain(STAGE);
      expect(text).not.toContain(TASK);
      expect(await panel.locator("a[href*='/projects/']").count()).toBe(0);
      expect(await panel.locator(`a[href="${taskHref()}"]`).count()).toBe(0);
      expect(await panel.locator(`a[href="${plainHref()}"]`).count()).toBeGreaterThan(0);
      await ctx.close();
    });
  });
});
