// APL-2609 (SHO-BUG-2) and APL-2726 (CRM_VISIBLE enforcement) story spec for one running server, in Playwright.
// tests/e2e/local/APL-2609.spec.ts starts one server per mode and stays the full check (`npm run test:crm-modes`).
// This file runs against BASE_URL (or TASKBOARD_URL), the way staging-e2e.yml runs every story spec.
// CRM_VISIBLE names the server's mode (all, admins or off; staging runs all). Every test asserts what that mode must show,
// so a server whose lever differs from CRM_VISIBLE fails here. Nothing is skipped except by the SHO_QA_PASS gate.
// A deal cannot be created while the CRM is hidden, so for admins or off, APL2609_SEED_URL names an all server on the same
// database. The deal and its people are made there; every assertion is made on BASE_URL.
// People are nakul17+ aliases signed in with SHO_QA_PASS. The Super Admin is nakul17+zz-sa@aplyd.com, which the server must
// list in SUPER_ADMIN_EMAILS. Records are ZZ-TEST and cleaned up through the API afterwards: projects and the organisation
// archived, chats cleared, the run's people deactivated. A failed clean-up step fails the file.
// No TC id is registered for APL-2609, so every title says "qa:TC missing". Nothing here targets production.
// LOCAL SANDBOX ONLY. Each run makes new nakul17+ aliases and verifies them from the server's local outbox
// (EMAIL_OUTBOX_DIR), so it cannot run against staging, where mail is not a local file. beforeAll fails with that
// message when the outbox is not readable.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test, expect, type Browser, type Page } from "@playwright/test";
import { assertStoryTargetAllowed } from "../base-url";

const QA_PASS = process.env.SHO_QA_PASS ?? "";
const BASE = (process.env.BASE_URL || process.env.TASKBOARD_URL || "http://localhost:3100").replace(/\/+$/, "");
const MODE = (process.env.CRM_VISIBLE || "all") as "all" | "admins" | "off";
const SEED = (process.env.APL2609_SEED_URL || (MODE === "all" ? BASE : "")).replace(/\/+$/, "");
const OUTBOX = process.env.EMAIL_OUTBOX_DIR ?? ".outbox";
const SUPER_EMAIL = "nakul17+zz-sa@aplyd.com";
const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const DEAL_NAME = `ZZ-TEST Globex renewal ${runId}`;
const DEAL_TASK = `ZZ-TEST Globex pricing ${runId}`;
const PLAIN_PROJECT = `ZZ-TEST workshop ${runId}`;
const PLAIN_TASK = `ZZ-TEST plain workshop ${runId}`;
const STAGE = "Proposal";

type Role = "editor" | "admin" | "superAdmin";
type Who = { id: string; cookie: string; label: string; role: Role };
type Row = { id: string; project: { type: string } };
type HttpResult = { status: number; text: string; json: Record<string, unknown> | null; cookie: string };

const seed: { projectIds: string[]; orgId?: string; dealId?: string; dealTaskId?: string; plainId?: string; plainTaskId?: string } = { projectIds: [] };
const people: { lead?: Who; editor?: Who; admin?: Who; superAdmin?: Who } = {};

/** Whether this server's mode shows the CRM to a person with this role (src/lib/crm.ts). */
const visibleTo = (role: Role) => MODE === "all" || (MODE === "admins" && role !== "editor");

function istDate(offsetDays: number) {
  return new Date(Date.now() + 5.5 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

function noSecret(text: string) {
  if (QA_PASS) expect(text.includes(QA_PASS), "a response echoed SHO_QA_PASS").toBe(false);
}

async function call(base: string, cookie: string, method: string, p: string, body?: unknown): Promise<HttpResult> {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const session = res.headers.getSetCookie().map((line) => line.split(";")[0]).find((line) => line.startsWith("sho_session="));
  const text = await res.text();
  noSecret(text);
  let json: Record<string, unknown> | null = null;
  if (text && res.headers.get("content-type")?.includes("json")) json = JSON.parse(text) as Record<string, unknown>;
  return { status: res.status, text, json, cookie: session ?? cookie };
}

async function verifyToken(email: string) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    let files: string[] = [];
    try { files = readdirSync(OUTBOX).filter((f) => f.endsWith(".json")).sort(); } catch { files = []; }
    const mails = files.map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8")) as { to?: string; subject?: string; text?: string });
    const token = mails.filter((m) => (m.to ?? "").toLowerCase() === email && /Verify/.test(m.subject ?? "")).at(-1)?.text?.match(/token=([\w-]+)/)?.[1];
    if (token) return token;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

/** Signs a nakul17+ alias in on the seed server, creating and verifying the account on first use. */
async function signIn(label: string, email: string, role: Role | "lead"): Promise<Who> {
  let signed = await call(SEED, "", "POST", "/api/auth/signin", { email, password: QA_PASS });
  if (signed.status !== 200) {
    const created = await call(SEED, "", "POST", "/api/auth/signup", { name: label, email, password: QA_PASS });
    expect(created.status, created.text).toBe(201);
    const token = await verifyToken(email);
    expect(token, `verification mail for ${label} in ${OUTBOX}`).toBeTruthy();
    expect((await call(SEED, "", "POST", "/api/auth/verify", { token })).status).toBe(200);
    signed = await call(SEED, "", "POST", "/api/auth/signin", { email, password: QA_PASS });
  }
  expect(signed.status, signed.text).toBe(200);
  const user = signed.json?.user as { id: string; orgRole?: string };
  return { id: user.id, cookie: signed.cookie, label, role: role === "lead" ? "editor" : role };
}

/** Everything one person learns about the deal on BASE: My tasks, search, the task routes, the concierge. */
async function surfaces(who: Who) {
  const my = await call(BASE, who.cookie, "GET", "/api/my-tasks");
  expect(my.status, my.text).toBe(200);
  const groups = my.json as Record<string, Row[]>;
  const rows = ["waitingOnMe", "overdue", "next7", "later", "waitingOnOthers"].flatMap((k) => groups[k] ?? []);
  const byName = await call(BASE, who.cookie, "GET", `/api/search?q=${encodeURIComponent(DEAL_NAME)}`);
  const byTask = await call(BASE, who.cookie, "GET", `/api/search?q=${encodeURIComponent(DEAL_TASK)}`);
  const detail = await call(BASE, who.cookie, "GET", `/api/tasks/${seed.dealTaskId}`);
  const list = await call(BASE, who.cookie, "GET", `/api/projects/${seed.dealId}/tasks`);
  const quick = await call(BASE, who.cookie, "POST", "/api/concierge/quick/due-week", {});
  const scoped = await call(BASE, who.cookie, "POST", "/api/concierge/quick/due-week", { projectId: seed.dealId });
  return {
    seen: {
      myTasks: rows.some((t) => t.id === seed.dealTaskId),
      stage: my.text.includes(STAGE) || rows.some((t) => t.project.type === "DEAL"),
      searchDeal: byName.text.includes(seed.dealId!),
      searchTask: byTask.text.includes(seed.dealTaskId!),
      taskRoute: detail.status,
      listRoute: list.status,
      concierge: quick.text.includes(DEAL_TASK) || quick.text.includes(DEAL_NAME),
      conciergeScoped: scoped.status,
    },
    plainShown: rows.some((t) => t.id === seed.plainTaskId),
  };
}

const HIDDEN = { myTasks: false, stage: false, searchDeal: false, searchTask: false, taskRoute: 404, listRoute: 404, concierge: false, conciergeScoped: 404 };
const SHOWN = { myTasks: true, stage: true, searchDeal: true, searchTask: true, taskRoute: 200, listRoute: 200, concierge: true, conciergeScoped: 200 };
const expected = (who: Who) => (visibleTo(who.role) ? SHOWN : HIDDEN);

/** The person's chat as the concierge panel loads it on BASE. */
async function chat(who: Who) {
  const r = await call(BASE, who.cookie, "GET", "/api/concierge/state");
  expect(r.status, r.text).toBe(200);
  return JSON.stringify(r.json?.messages ?? []);
}

/** A signed-in page on BASE. The session cookie is the one the API sign-in returned. */
async function pageAs(browser: Browser, who: Who): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const [name, value] = who.cookie.split("=");
  await ctx.addCookies([{ name, value, url: BASE }]);
  await ctx.request.post(`${BASE}/api/profile/start-guide`).catch(() => undefined);
  return ctx.newPage();
}

/** My tasks in the browser. Waits for the task in its list section, switching to By project where the control exists. */
async function myTasksScreen(browser: Browser, who: Who, waitFor: string, project: string) {
  const page = await pageAs(browser, who);
  try {
    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
    const row = (section: string) => page.getByRole("region", { name: section, exact: true }).getByRole("link", { name: waitFor, exact: true });
    await expect(row("Next 7 days")).toBeVisible({ timeout: 30_000 });
    const grouping = (await page.getByRole("group", { name: "Group tasks" }).count()) > 0;
    if (grouping) {
      const byProject = page.getByRole("button", { name: "By project" });
      await byProject.click();
      await expect(byProject).toHaveAttribute("aria-pressed", "true");
      await expect(row(project)).toBeVisible({ timeout: 30_000 });
    }
    const main = page.getByRole("main");
    return { grouping, text: (await main.textContent()) ?? "", dealChips: await main.getByText("Deal", { exact: true }).count() };
  } finally {
    await page.context().close();
  }
}

/** Search in the browser. An empty search echoes the words back ("Nothing matches ..."), so a leak is judged on the links. */
async function searchScreen(browser: Browser, who: Who, q: string) {
  const page = await pageAs(browser, who);
  try {
    await page.goto(`${BASE}/search`, { waitUntil: "domcontentloaded" });
    const box = page.getByRole("searchbox", { name: "Search" });
    await expect(box).toBeVisible({ timeout: 30_000 });
    const answered = page.waitForResponse((r) => r.url().includes("/api/search?q=") && r.status() === 200, { timeout: 30_000 });
    await box.fill(q);
    await answered;
    const main = page.getByRole("main");
    await expect.poll(async () => (await main.getByRole("link").allTextContents()).some((l) => l.includes(q))
      || (await main.getByText(`Nothing matches “${q}”`, { exact: false }).count()) > 0, { timeout: 30_000 }).toBe(true);
    return { links: await main.getByRole("link").allTextContents(), text: (await main.textContent()) ?? "" };
  } finally {
    await page.context().close();
  }
}

/** The task screen in the browser: a visible task redirects to its project; a hidden one answers 404 and stays put. */
async function taskScreen(browser: Browser, who: Who) {
  const page = await pageAs(browser, who);
  try {
    const answered = page.waitForResponse((r) => r.url().endsWith(`/api/tasks/${seed.dealTaskId}`), { timeout: 30_000 });
    await page.goto(`${BASE}/tasks/${seed.dealTaskId}`, { waitUntil: "domcontentloaded" });
    const status = (await answered).status();
    if (status === 200) await page.waitForURL(/\/projects\//, { timeout: 30_000 });
    else await expect(page.getByRole("heading", { name: "This task isn't available" })).toBeVisible({ timeout: 30_000 });
    return { status, url: page.url(), text: (await page.getByRole("main").textContent()) ?? "" };
  } finally {
    await page.context().close();
  }
}

/** Through the API on the seed server. Returns every step that did not succeed, so afterAll can fail with them. */
async function cleanup(): Promise<string[]> {
  const failed: string[] = [];
  const must = async (what: string, who: Who, method: string, p: string, body?: unknown) => {
    const r = await call(SEED, who.cookie, method, p, body).catch((e: unknown) => ({ status: 0, text: String(e) }));
    if (r.status < 200 || r.status > 299) failed.push(`${what}: ${r.status} ${r.text.slice(0, 200)}`);
  };
  const { lead, editor, admin, superAdmin } = people;
  if (lead && superAdmin) {
    for (const id of seed.projectIds) {
      await must(`hand ${id} to the Super Admin`, lead, "POST", `/api/projects/${id}/leader`, { newLeaderId: superAdmin.id, previousRole: "EDITOR" });
      await must(`archive ${id}`, superAdmin, "POST", `/api/projects/${id}/archive`);
    }
  }
  if (superAdmin && seed.orgId) await must("archive the organisation", superAdmin, "POST", `/api/orgs/${seed.orgId}/archive`, { archive: true });
  for (const who of [lead, editor, admin, superAdmin]) if (who) await must(`clear ${who.label}'s chat`, who, "DELETE", "/api/concierge/messages");
  if (superAdmin) for (const who of [lead, editor, admin]) if (who) await must(`deactivate ${who.label}`, superAdmin, "POST", `/api/team/${who.id}/deactivate`, { reassign: "leaders" });
  return failed;
}

test.describe.configure({ mode: "serial", timeout: 180_000 });

test.describe("qa:TC missing APL-2609 CRM_VISIBLE hides deals on this server's mode, in the browser and over HTTP", { tag: "@local-only" }, () => {
  test.beforeAll(() => {
    test.skip(!QA_PASS, "APL-2609: set SHO_QA_PASS (the password for nakul17+ aliases).");
  });

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    expect(["all", "admins", "off"], `CRM_VISIBLE=${MODE}`).toContain(MODE);
    expect(SEED, `CRM_VISIBLE=${MODE}: set APL2609_SEED_URL to an all server on the same database (a deal cannot be made while the CRM is hidden)`).toBeTruthy();
    // Both URLs are passed in, so the guard never falls back to reading the process environment.
    assertStoryTargetAllowed(process.env, BASE);
    assertStoryTargetAllowed(process.env, SEED);
    expect(existsSync(OUTBOX), `APL-2609 story spec is local-sandbox-only: it verifies new aliases from the server's local outbox (EMAIL_OUTBOX_DIR=${OUTBOX})`).toBe(true);
    const health = await call(BASE, "", "GET", "/api/health");
    expect(health.status, health.text).toBe(200);

    people.superAdmin = await signIn("ZZ-TEST QA Admin", SUPER_EMAIL, "superAdmin");
    const me = await call(SEED, people.superAdmin.cookie, "GET", "/api/auth/me");
    expect(me.text, `${SUPER_EMAIL} must be listed in SUPER_ADMIN_EMAILS`).toContain("SUPER_ADMIN");
    const email = (label: string) => `nakul17+zz2609-${label}-${runId}@aplyd.com`;
    const lead = await signIn("ZZ-TEST lead", email("lead"), "lead");
    const editor = await signIn("ZZ-TEST editor", email("editor"), "editor");
    const admin = await signIn("ZZ-TEST admin", email("admin"), "admin");
    Object.assign(people, { lead, editor, admin });
    const promoted = await call(SEED, people.superAdmin.cookie, "PATCH", `/api/team/${admin.id}`, { orgRole: "ADMIN" });
    expect(promoted.status, promoted.text).toBe(200);

    const pipes = await call(SEED, lead.cookie, "GET", "/api/deals/pipelines");
    expect(pipes.status, `the seed server must run CRM_VISIBLE=all: ${pipes.text}`).toBe(200);
    const pipe = (pipes.json?.pipelines as { id: string; key: string; stages: { id: string; name: string }[] }[]).find((p) => p.key === "DEAL_PROACTIVE");
    const proposal = pipe?.stages.find((s) => s.name === STAGE);
    expect(proposal?.id).toBeTruthy();
    const org = await call(SEED, lead.cookie, "POST", "/api/orgs", { name: `ZZ-TEST buyer ${runId}` });
    expect(org.status, org.text).toBe(201);
    seed.orgId = (org.json?.organisation as { id: string }).id;
    const made = await call(SEED, lead.cookie, "POST", "/api/deals", {
      name: DEAL_NAME, organisationId: seed.orgId, pipelineId: pipe!.id, leaderId: lead.id, whyPursue: `ZZ-TEST-2609-${runId}`,
      nextStep: { title: `ZZ-TEST first call ${runId}`, dueDate: istDate(3) },
    });
    expect(made.status, made.text).toBe(201);
    seed.dealId = (made.json?.deal as { id: string }).id;
    seed.projectIds.push(seed.dealId);
    expect((await call(SEED, lead.cookie, "POST", `/api/projects/${seed.dealId}/stage`, { stageId: proposal!.id })).status).toBe(200);
    for (const who of [editor, admin, people.superAdmin]) {
      const added = await call(SEED, lead.cookie, "POST", `/api/projects/${seed.dealId}/members`, { userId: who.id, role: "EDITOR" });
      expect(added.status, added.text).toBe(201);
    }
    const dealTask = await call(SEED, lead.cookie, "POST", `/api/projects/${seed.dealId}/tasks`, { title: DEAL_TASK, assigneeId: editor.id, dueDate: istDate(2) });
    expect(dealTask.status, dealTask.text).toBe(201);
    seed.dealTaskId = (dealTask.json?.task as { id: string }).id;
    for (const who of [admin, people.superAdmin]) expect((await call(SEED, lead.cookie, "POST", `/api/tasks/${seed.dealTaskId}/collaborators`, { userId: who.id })).status).toBe(201);

    const plain = await call(SEED, lead.cookie, "POST", "/api/projects", { name: PLAIN_PROJECT, leaderId: lead.id });
    expect(plain.status, plain.text).toBe(201);
    seed.plainId = (plain.json?.project as { id: string }).id;
    seed.projectIds.push(seed.plainId);
    for (const who of [editor, admin, people.superAdmin]) expect((await call(SEED, lead.cookie, "POST", `/api/projects/${seed.plainId}/members`, { userId: who.id, role: "EDITOR" })).status).toBe(201);
    const plainTask = await call(SEED, lead.cookie, "POST", `/api/projects/${seed.plainId}/tasks`, { title: PLAIN_TASK, assigneeId: editor.id, dueDate: istDate(2) });
    expect(plainTask.status, plainTask.text).toBe(201);
    seed.plainTaskId = (plainTask.json?.task as { id: string }).id;
    // The Admin and the Super Admin hold the plain task too, so My tasks has a row for them in every mode.
    for (const who of [admin, people.superAdmin]) expect((await call(SEED, lead.cookie, "POST", `/api/tasks/${seed.plainTaskId}/collaborators`, { userId: who.id })).status).toBe(201);
  });

  test.afterAll(async () => {
    if (!QA_PASS) return;
    const failed = await cleanup();
    if (failed.length) throw new Error(`ZZ-TEST cleanup failed: ${failed.join("; ")}`);
  });

  test("qa:TC missing AC1 AC2 AC3 AC4 AC5 AC7: a deal member who is an Editor sees deal data on every surface only when this mode shows it", async ({ browser }) => {
    const editor = people.editor!;
    const { seen, plainShown } = await surfaces(editor);
    expect(seen).toEqual(expected(editor));
    expect(plainShown).toBe(true);
    const shown = visibleTo("editor");

    const tasks = await myTasksScreen(browser, editor, shown ? DEAL_TASK : PLAIN_TASK, shown ? DEAL_NAME : PLAIN_PROJECT);
    expect(tasks.grouping).toBe(shown);
    for (const word of [DEAL_NAME, STAGE]) expect(tasks.text.includes(word), word).toBe(shown);
    expect(tasks.dealChips > 0).toBe(shown);

    for (const q of [DEAL_NAME, DEAL_TASK]) {
      const search = await searchScreen(browser, editor, q);
      expect(search.links.some((l) => l.includes(q)), q).toBe(shown);
      if (!shown) expect(search.text, q).not.toContain(STAGE);
    }
    expect((await searchScreen(browser, editor, PLAIN_TASK)).links.some((l) => l.includes(PLAIN_TASK))).toBe(true);

    const task = await taskScreen(browser, editor);
    expect(task.status).toBe(shown ? 200 : 404);
    expect(task.url.includes(`/projects/${seed.dealId}`)).toBe(shown);
    if (!shown) for (const word of [DEAL_NAME, DEAL_TASK, STAGE]) expect(task.text).not.toContain(word);
  });

  test("qa:TC missing AC6 AC7 AC8: an Admin and the Super Admin see deal tasks unless this mode is off", async ({ browser }) => {
    for (const who of [people.admin!, people.superAdmin!]) {
      expect((await surfaces(who)).seen, who.label).toEqual(expected(who));
      const shown = visibleTo(who.role);
      const tasks = await myTasksScreen(browser, who, shown ? DEAL_TASK : PLAIN_TASK, shown ? DEAL_NAME : PLAIN_PROJECT);
      expect(tasks.grouping, who.label).toBe(shown);
      for (const word of [DEAL_NAME, STAGE]) expect(tasks.text.includes(word), `${who.label}: ${word}`).toBe(shown);
      expect((await taskScreen(browser, who)).status, who.label).toBe(shown ? 200 : 404);
    }
    expect((await searchScreen(browser, people.admin!, DEAL_NAME)).links.some((l) => l.includes(DEAL_NAME))).toBe(visibleTo("admin"));
  });

  test("qa:TC missing AC4 AC8: chat written while the CRM was visible is shown on this server only to people this mode shows the CRM to", async () => {
    // Asked on the seed server, where the CRM is visible, so the stored answer names the deal task.
    for (const who of [people.editor!, people.admin!]) {
      const asked = await call(SEED, who.cookie, "POST", "/api/concierge/quick/due-week", {});
      expect(asked.status, asked.text).toBe(200);
      expect(asked.text).toContain(DEAL_TASK);
    }
    for (const who of [people.editor!, people.admin!]) {
      const now = await chat(who);
      expect(now.includes(DEAL_TASK), who.label).toBe(visibleTo(who.role));
      if (!visibleTo(who.role)) expect(now, who.label).not.toContain(DEAL_NAME);
    }
  });

  test("qa:TC missing AC5 AC8: an Admin demoted to Member sees their earlier deal chat only while this mode shows the CRM to Members", async () => {
    const admin = people.admin!;
    const setRole = async (orgRole: "MEMBER" | "ADMIN") => {
      const r = await call(BASE, people.superAdmin!.cookie, "PATCH", `/api/team/${admin.id}`, { orgRole });
      expect(r.status, r.text).toBe(200);
    };
    const asked = await call(BASE, admin.cookie, "POST", "/api/concierge/quick/due-week", {});
    expect(asked.status, asked.text).toBe(200);
    expect(asked.text.includes(DEAL_TASK)).toBe(visibleTo("admin"));
    expect((await chat(admin)).includes(DEAL_TASK)).toBe(visibleTo("admin"));
    await setRole("MEMBER");
    try {
      const now = await chat(admin);
      expect(now.includes(DEAL_TASK)).toBe(visibleTo("editor"));
      if (!visibleTo("editor")) for (const word of [DEAL_NAME, STAGE]) expect(now).not.toContain(word);
    } finally {
      await setRole("ADMIN");
    }
    expect((await chat(admin)).includes(DEAL_TASK)).toBe(visibleTo("admin"));
  });
});
