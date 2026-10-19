// APL-2609 (SHO-BUG-2) and APL-2726 (CRM_VISIBLE enforcement) story spec, one test per acceptance criterion.
// One `next start` per CRM_VISIBLE mode (all, admins, off) on the same database, the same shape as
// tests/apl-2713-crm-modes.test.ts, and Playwright Chromium on My tasks, Search and the task screen.
// Run with `npm run test:crm-modes` after `npm run build`. `npm test` does not start these servers.
// Locally set PW_CHROMIUM to a chrome binary; CI installs Playwright Chromium first.
// Every mode server is started, so no acceptance criterion depends on the lever of a shared server, and none is skipped.
// Records use ZZ-TEST names and are deleted afterwards. Pam left no qa:TC id on the issue, so every title says "qa:TC missing".
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../../src/lib/db";
import { istDate, PW, SUPER_EMAIL } from "../../helpers";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const runId = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const tag = `ZZ-TEST-2609-${runId}`;
const DEAL_NAME = `ZZ-TEST Globex renewal ${runId}`;
const DEAL_TASK = `ZZ-TEST Globex pricing ${runId}`;
const PLAIN_TASK = `ZZ-TEST plain workshop ${runId}`;
const STAGE = "Proposal";
const MODES = ["all", "admins", "off"] as const;
type Mode = (typeof MODES)[number];
type Who = { id: string; cookie: string; label: string };
type Running = { mode: Mode; port: number; pid: number; outbox: string; base: string };
type Row = { id: string; title: string; project: { id: string; name: string; type: string; stage: string | null } };

const running = new Map<Mode, Running>();
const seed: { userIds: string[]; emails: string[]; projectIds: string[]; orgId?: string; dealId?: string; dealTaskId?: string; plainTaskId?: string } = {
  userIds: [], emails: [], projectIds: [],
};
const people: { editor?: Who; admin?: Who; superAdmin?: Who } = {};
let browser: Browser | null = null;
const started = new Date();

async function cleanupSeed() {
  const userIds = seed.userIds;
  if (userIds.length || seed.projectIds.length) {
    await db.actionLog.deleteMany({
      where: { OR: [...(userIds.length ? [{ actorId: { in: userIds } }] : []), ...(seed.projectIds.length ? [{ projectId: { in: seed.projectIds } }] : [])] },
    });
  }
  if (people.superAdmin) await db.chatMessage.deleteMany({ where: { userId: people.superAdmin.id, createdAt: { gte: started } } });
  if (userIds.length) {
    await db.modelUsage.deleteMany({ where: { userId: { in: userIds } } });
    await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  }
  if (seed.projectIds.length) await db.project.deleteMany({ where: { id: { in: seed.projectIds } } });
  if (seed.orgId) await db.organisation.deleteMany({ where: { id: seed.orgId } });
  if (seed.emails.length) await db.loginAttempt.deleteMany({ where: { email: { in: seed.emails } } });
  if (userIds.length) await db.user.deleteMany({ where: { id: { in: userIds } } });
}
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
    server.on("error", reject);
  });
}

/** Stops the server this file started, by its own process group id. Never by name or port. */
function killGroup(pid: number | undefined) {
  if (!pid || pid === process.pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

function scrub(text: string) {
  return text
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgresql://[redacted]")
    .replace(/(password|secret|token|api_key)(["'=:\s]+)(\S+)/gi, "$1$2[redacted]");
}

async function waitForHealth(port: number, child: ChildProcess, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let exited: string | null = null;
  child.once("exit", (code, signal) => { exited = `exited ${code ?? signal}`; });
  child.once("error", (err) => { exited = err.message; });
  while (Date.now() < deadline) {
    if (exited || child.exitCode !== null) throw new Error(`CRM_VISIBLE mode cannot start (${exited ?? `exited ${child.exitCode}`})`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`CRM_VISIBLE mode cannot start (no healthy response on port ${port})`);
}

async function startModeServer(mode: Mode): Promise<Running> {
  const port = await freePort();
  const outbox = mkdtempSync(path.join(tmpdir(), `sho-apl2609-${mode}-`));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    CRM_VISIBLE: mode,
    EMAIL_OUTBOX_DIR: outbox,
    APP_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
    SUPER_ADMIN_EMAILS: SUPER_EMAIL,
    JOB_SECRET: process.env.JOB_SECRET || "replace-with-a-token-of-at-least-16-chars",
  };
  const logFd = openSync(path.join(outbox, "server.log"), "a");
  const child = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(port)], { cwd: root, env, detached: true, stdio: ["ignore", logFd, logFd] });
  closeSync(logFd);
  child.unref();
  try {
    await waitForHealth(port, child, 60_000);
  } catch (err) {
    killGroup(child.pid);
    const log = existsSync(path.join(outbox, "server.log")) ? scrub(readFileSync(path.join(outbox, "server.log"), "utf8")).slice(-1500) : "";
    const message = err instanceof Error ? err.message : `CRM_VISIBLE=${mode} cannot start`;
    throw new Error(`${message}${log ? `\n${log}` : ""}`);
  }
  if (!child.pid) throw new Error(`CRM_VISIBLE=${mode} cannot start`);
  return { mode, port, pid: child.pid, outbox, base: `http://127.0.0.1:${port}` };
}

type HttpResult = { status: number; text: string; json: Record<string, unknown> | null; cookie: string };

async function call(base: string, cookie: string, method: string, p: string, body?: unknown): Promise<HttpResult> {
  const res = await fetch(base + p, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sets = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const session = sets.map((line) => line.split(";")[0]).find((line) => line.startsWith("sho_session="));
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  if (text && res.headers.get("content-type")?.includes("json")) json = JSON.parse(text) as Record<string, unknown>;
  return { status: res.status, text, json, cookie: session ?? cookie };
}

function verifyToken(outbox: string, email: string) {
  const want = email.toLowerCase();
  const files = readdirSync(outbox).filter((f) => f.endsWith(".json")).sort();
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(outbox, f), "utf8")) as { to?: string; subject?: string; text?: string });
  const mine = mails.filter((m) => (m.to ?? "").toLowerCase() === want && /Verify/.test(m.subject ?? ""));
  return mine.at(-1)?.text?.match(/token=([\w-]+)/)?.[1] ?? null;
}

async function signIn(server: Running, label: string, email: string): Promise<Who> {
  const created = await call(server.base, "", "POST", "/api/auth/signup", { name: label, email, password: PW });
  if (created.status === 201) {
    const token = verifyToken(server.outbox, email);
    expect(token, `verification mail for ${label}`).toBeTruthy();
    expect((await call(server.base, "", "POST", "/api/auth/verify", { token })).status).toBe(200);
  } else {
    expect(created.status, created.text).toBe(409);
  }
  const signed = await call(server.base, "", "POST", "/api/auth/signin", { email, password: PW });
  expect(signed.status, signed.text).toBe(200);
  const user = signed.json?.user as { id: string } | undefined;
  expect(user?.id).toBeTruthy();
  return { id: user!.id, cookie: signed.cookie, label };
}

const server = (mode: Mode) => {
  const s = running.get(mode);
  if (!s) throw new Error(`CRM_VISIBLE=${mode} server is not running`);
  return s;
};

/** A signed-in browser page on one mode's server. The session cookie is the one the API sign-in returned. */
async function pageAs(mode: Mode, who: Who): Promise<Page> {
  const s = server(mode);
  const ctx = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
  const [name, value] = who.cookie.split("=");
  await ctx.addCookies([{ name, value, url: s.base }]);
  const page = await ctx.newPage();
  await ctx.request.post(`${s.base}/api/profile/start-guide`).catch(() => undefined);
  return page;
}

/** Everything one person learns about the deal on one mode's server: My tasks, search, the task routes, the concierge. */
async function surfaces(mode: Mode, who: Who) {
  const s = server(mode);
  const my = await call(s.base, who.cookie, "GET", "/api/my-tasks");
  expect(my.status, my.text).toBe(200);
  const groups = my.json as Record<string, Row[]>;
  const rows = ["waitingOnMe", "overdue", "next7", "later", "waitingOnOthers"].flatMap((k) => groups[k] ?? []);
  const byName = await call(s.base, who.cookie, "GET", `/api/search?q=${encodeURIComponent(DEAL_NAME)}`);
  const byTask = await call(s.base, who.cookie, "GET", `/api/search?q=${encodeURIComponent(DEAL_TASK)}`);
  const detail = await call(s.base, who.cookie, "GET", `/api/tasks/${seed.dealTaskId}`);
  const list = await call(s.base, who.cookie, "GET", `/api/projects/${seed.dealId}/tasks`);
  const quick = await call(s.base, who.cookie, "POST", "/api/concierge/quick/due-week", {});
  const scoped = await call(s.base, who.cookie, "POST", "/api/concierge/quick/due-week", { projectId: seed.dealId });
  return {
    myTasks: rows.some((t) => t.id === seed.dealTaskId),
    stage: my.text.includes(STAGE) || rows.some((t) => t.project.type === "DEAL"),
    searchDeal: byName.text.includes(seed.dealId!),
    searchTask: byTask.text.includes(seed.dealTaskId!),
    taskRoute: detail.status,
    listRoute: list.status,
    concierge: quick.text.includes(DEAL_TASK) || quick.text.includes(DEAL_NAME),
    conciergeScoped: scoped.status,
    plainShown: rows.some((t) => t.id === seed.plainTaskId),
  };
}

const HIDDEN = { myTasks: false, stage: false, searchDeal: false, searchTask: false, taskRoute: 404, listRoute: 404, concierge: false, conciergeScoped: 404 };
const SHOWN = { myTasks: true, stage: true, searchDeal: true, searchTask: true, taskRoute: 200, listRoute: 200, concierge: true, conciergeScoped: 200 };
const strip = (x: Awaited<ReturnType<typeof surfaces>>) => { const { plainShown, ...rest } = x; void plainShown; return rest; };

/**
 * My tasks in the browser. The By date / By project control exists only while the CRM is visible to the viewer; when it does,
 * this switches to By project, where a deal shows its Deal chip and stage. Waits for a task, then reads the page.
 */
async function myTasksScreen(mode: Mode, who: Who, waitFor: string) {
  const page = await pageAs(mode, who);
  try {
    await page.goto(`${server(mode).base}/`, { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: waitFor, exact: true }).first().waitFor({ timeout: 30_000 });
    const grouping = (await page.getByRole("group", { name: "Group tasks" }).count()) > 0;
    if (grouping) {
      const byProject = page.getByRole("button", { name: "By project" });
      await byProject.click();
      await expect.poll(() => byProject.getAttribute("aria-pressed"), { timeout: 10_000 }).toBe("true");
      await page.getByRole("link", { name: waitFor, exact: true }).first().waitFor({ timeout: 30_000 });
    }
    const main = page.getByRole("main");
    return { grouping, text: (await main.textContent()) ?? "", dealChips: await main.getByText("Deal", { exact: true }).count() };
  } finally {
    await page.context().close();
  }
}

/**
 * Search in the browser: types the text and waits for the answer to the request it makes. Returns the result links and the
 * page text. An empty search echoes the person's own words back ("Nothing matches ..."), so a leak is judged on the links.
 */
async function searchScreen(mode: Mode, who: Who, q: string) {
  const page = await pageAs(mode, who);
  try {
    await page.goto(`${server(mode).base}/search`, { waitUntil: "domcontentloaded" });
    const box = page.getByRole("searchbox", { name: "Search" });
    await box.waitFor({ timeout: 30_000 });
    const answered = page.waitForResponse((r) => r.url().includes("/api/search?q=") && r.status() === 200, { timeout: 30_000 });
    await box.fill(q);
    await answered;
    await page.waitForTimeout(300);
    const main = page.getByRole("main");
    const links = await main.getByRole("link").allTextContents();
    return { links, text: (await main.textContent()) ?? "" };
  } finally {
    await page.context().close();
  }
}

/** The task screen in the browser: a visible task redirects to its project; a hidden one answers 404 and stays put. */
async function taskScreen(mode: Mode, who: Who) {
  const page = await pageAs(mode, who);
  try {
    const answered = page.waitForResponse((r) => r.url().endsWith(`/api/tasks/${seed.dealTaskId}`), { timeout: 30_000 });
    await page.goto(`${server(mode).base}/tasks/${seed.dealTaskId}`, { waitUntil: "domcontentloaded" });
    const status = (await answered).status();
    if (status === 200) await page.waitForURL(/\/projects\//, { timeout: 30_000 });
    else await page.waitForTimeout(500);
    return { status, url: page.url(), text: (await page.locator("body").textContent()) ?? "" };
  } finally {
    await page.context().close();
  }
}

describe("qa:TC missing APL-2609 CRM_VISIBLE hides deals on a real server per mode, in the browser and over HTTP", () => {
  beforeAll(async () => {
    if (!existsSync(path.join(root, ".next", "BUILD_ID"))) {
      throw new Error("CRM_VISIBLE mode cannot start: the production build is missing (.next/BUILD_ID)");
    }
    await db.$connect();
    browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
    await Promise.all(MODES.map(async (mode) => { running.set(mode, await startModeServer(mode)); }));

    // One world on the shared database, made through the `all` server.
    const open = server("all");
    const emails = { lead: `lead.${tag}@aplyd.com`, editor: `editor.${tag}@aplyd.com`, admin: `admin.${tag}@aplyd.com` };
    for (const e of Object.values(emails)) seed.emails.push(e.toLowerCase());
    const lead = await signIn(open, "ZZ-TEST lead", emails.lead.toLowerCase());
    const editor = await signIn(open, "ZZ-TEST editor", emails.editor.toLowerCase());
    const adminUser = await signIn(open, "ZZ-TEST admin", emails.admin.toLowerCase());
    seed.userIds.push(lead.id, editor.id, adminUser.id);
    await db.user.update({ where: { id: adminUser.id }, data: { orgRole: "ADMIN" } });
    people.editor = editor;
    people.admin = adminUser;
    people.superAdmin = await signIn(open, "Root", SUPER_EMAIL);

    const pipes = await call(open.base, lead.cookie, "GET", "/api/deals/pipelines");
    expect(pipes.status, pipes.text).toBe(200);
    const pipe = (pipes.json?.pipelines as { id: string; key: string; stages: { id: string; name: string }[] }[]).find((p) => p.key === "DEAL_PROACTIVE");
    const proposal = pipe?.stages.find((s) => s.name === STAGE);
    expect(proposal?.id).toBeTruthy();
    const org = await call(open.base, lead.cookie, "POST", "/api/orgs", { name: `Buyer ${tag}` });
    expect(org.status, org.text).toBe(201);
    seed.orgId = (org.json?.organisation as { id: string }).id;
    const made = await call(open.base, lead.cookie, "POST", "/api/deals", {
      name: DEAL_NAME, organisationId: seed.orgId, pipelineId: pipe!.id, leaderId: lead.id, whyPursue: tag,
      nextStep: { title: `ZZ-TEST first call ${runId}`, dueDate: istDate(3) },
    });
    expect(made.status, made.text).toBe(201);
    seed.dealId = (made.json?.deal as { id: string }).id;
    seed.projectIds.push(seed.dealId);
    expect((await call(open.base, lead.cookie, "POST", `/api/projects/${seed.dealId}/stage`, { stageId: proposal!.id })).status).toBe(200);
    for (const who of [editor, adminUser]) {
      const added = await call(open.base, lead.cookie, "POST", `/api/projects/${seed.dealId}/members`, { userId: who.id, role: "EDITOR" });
      expect(added.status, added.text).toBe(201);
    }
    const dealTask = await call(open.base, lead.cookie, "POST", `/api/projects/${seed.dealId}/tasks`, { title: DEAL_TASK, assigneeId: editor.id, dueDate: istDate(2) });
    expect(dealTask.status, dealTask.text).toBe(201);
    seed.dealTaskId = (dealTask.json?.task as { id: string }).id;
    expect((await call(open.base, lead.cookie, "POST", `/api/tasks/${seed.dealTaskId}/collaborators`, { userId: adminUser.id })).status).toBe(201);

    const plain = await call(open.base, lead.cookie, "POST", "/api/projects", { name: `ZZ-TEST workshop ${runId}`, leaderId: lead.id });
    expect(plain.status, plain.text).toBe(201);
    const plainId = (plain.json?.project as { id: string }).id;
    seed.projectIds.push(plainId);
    for (const who of [editor, adminUser]) expect((await call(open.base, lead.cookie, "POST", `/api/projects/${plainId}/members`, { userId: who.id, role: "EDITOR" })).status).toBe(201);
    const plainTask = await call(open.base, lead.cookie, "POST", `/api/projects/${plainId}/tasks`, { title: PLAIN_TASK, assigneeId: editor.id, dueDate: istDate(2) });
    expect(plainTask.status, plainTask.text).toBe(201);
    seed.plainTaskId = (plainTask.json?.task as { id: string }).id;
    expect((await call(open.base, lead.cookie, "POST", `/api/tasks/${seed.plainTaskId}/collaborators`, { userId: adminUser.id })).status).toBe(201);
  }, 240_000);

  afterAll(async () => {
    try { await cleanupSeed(); } finally {
      for (const s of running.values()) killGroup(s.pid);
      await browser?.close();
    }
  }, 60_000);

  it("qa:TC missing AC1: with CRM_VISIBLE=off, My tasks shows a deal member no deal task and no stage", async () => {
    const seen = await surfaces("off", people.editor!);
    expect({ myTasks: seen.myTasks, stage: seen.stage, plainShown: seen.plainShown }).toEqual({ myTasks: false, stage: false, plainShown: true });
    const screen = await myTasksScreen("off", people.editor!, PLAIN_TASK);
    for (const word of [DEAL_NAME, DEAL_TASK, STAGE]) expect(screen.text).not.toContain(word);
    expect(screen.dealChips).toBe(0);
    expect(screen.grouping).toBe(false);
  });

  it("qa:TC missing AC2: with CRM_VISIBLE=off, searching the deal name or a deal task title returns nothing of the deal", async () => {
    const seen = await surfaces("off", people.editor!);
    expect({ searchDeal: seen.searchDeal, searchTask: seen.searchTask }).toEqual({ searchDeal: false, searchTask: false });
    for (const q of [DEAL_NAME, DEAL_TASK]) {
      const screen = await searchScreen("off", people.editor!, q);
      expect(screen.links.some((l) => l.includes(DEAL_NAME) || l.includes(DEAL_TASK)), q).toBe(false);
      expect(screen.text, q).toContain("Nothing matches");
      expect(screen.text, q).not.toContain(STAGE);
    }
    expect((await searchScreen("off", people.editor!, PLAIN_TASK)).links.some((l) => l.includes(PLAIN_TASK))).toBe(true);
  });

  it("qa:TC missing AC3: with CRM_VISIBLE=off, the deal task screen, its route and the deal task list answer not found", async () => {
    const seen = await surfaces("off", people.editor!);
    expect({ taskRoute: seen.taskRoute, listRoute: seen.listRoute }).toEqual({ taskRoute: 404, listRoute: 404 });
    const screen = await taskScreen("off", people.editor!);
    expect(screen.status).toBe(404);
    expect(screen.url).not.toContain(`/projects/${seed.dealId}`);
    for (const word of [DEAL_NAME, DEAL_TASK, STAGE]) expect(screen.text).not.toContain(word);
  });

  it("qa:TC missing AC4: with CRM_VISIBLE=off, the concierge quick actions never mention the deal or its task", async () => {
    const seen = await surfaces("off", people.editor!);
    expect({ concierge: seen.concierge, conciergeScoped: seen.conciergeScoped }).toEqual({ concierge: false, conciergeScoped: 404 });
    const quick = await call(server("off").base, people.editor!.cookie, "POST", "/api/concierge/quick/due-week", {});
    expect(quick.status, quick.text).toBe(200);
    expect(quick.text).toContain(PLAIN_TASK);
    for (const word of [DEAL_NAME, DEAL_TASK, STAGE]) expect(quick.text).not.toContain(word);
  });

  it("qa:TC missing AC5: with CRM_VISIBLE=admins, an Editor sees no deal data on any surface", async () => {
    const seen = await surfaces("admins", people.editor!);
    expect(strip(seen)).toEqual(HIDDEN);
    expect(seen.plainShown).toBe(true);
    const screen = await myTasksScreen("admins", people.editor!, PLAIN_TASK);
    for (const word of [DEAL_NAME, DEAL_TASK, STAGE]) expect(screen.text).not.toContain(word);
    expect(screen.grouping).toBe(false);
    expect((await taskScreen("admins", people.editor!)).status).toBe(404);
  });

  it("qa:TC missing AC6: with CRM_VISIBLE=admins, an Admin and the Super Admin see deal tasks as normal", async () => {
    expect(strip(await surfaces("admins", people.admin!))).toEqual(SHOWN);
    const screen = await myTasksScreen("admins", people.admin!, DEAL_TASK);
    expect(screen.grouping).toBe(true);
    expect(screen.text).toContain(DEAL_NAME);
    expect(screen.text).toContain(STAGE);
    expect(screen.dealChips).toBeGreaterThan(0);
    expect((await searchScreen("admins", people.admin!, DEAL_NAME)).links.some((l) => l.includes(DEAL_NAME))).toBe(true);
    expect((await taskScreen("admins", people.admin!)).url).toContain(`/projects/${seed.dealId}`);
    // The Super Admin is not a member: no My tasks row or quick-action line of theirs, but every other surface shows the deal.
    const sa = await surfaces("admins", people.superAdmin!);
    expect(strip(sa)).toEqual({ ...SHOWN, myTasks: false, stage: false, concierge: false });
  });

  it("qa:TC missing AC7: with CRM_VISIBLE=all, every member's behaviour is unchanged", async () => {
    expect(strip(await surfaces("all", people.editor!))).toEqual(SHOWN);
    expect(strip(await surfaces("all", people.admin!))).toEqual(SHOWN);
    const screen = await myTasksScreen("all", people.editor!, DEAL_TASK);
    expect(screen.grouping).toBe(true);
    expect(screen.text).toContain(DEAL_NAME);
    expect(screen.text).toContain(STAGE);
    expect((await taskScreen("all", people.editor!)).url).toContain(`/projects/${seed.dealId}`);
  });

  it("qa:TC missing AC8: CRM_VISIBLE=off hides deals from Admins and the Super Admin too; admins mode keeps them in", async () => {
    expect(strip(await surfaces("off", people.admin!))).toEqual(HIDDEN);
    expect(strip(await surfaces("off", people.superAdmin!))).toEqual(HIDDEN);
    const screen = await myTasksScreen("off", people.admin!, PLAIN_TASK);
    for (const word of [DEAL_NAME, DEAL_TASK, STAGE]) expect(screen.text).not.toContain(word);
    expect(screen.grouping).toBe(false);
    expect((await taskScreen("off", people.superAdmin!)).status).toBe(404);
    expect((await surfaces("admins", people.admin!)).taskRoute).toBe(200);
    expect((await surfaces("admins", people.superAdmin!)).taskRoute).toBe(200);
  });
});
