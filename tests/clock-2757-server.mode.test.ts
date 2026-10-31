// SHO-2757: the timed portions of APL-2525 AC6, APL-2543 AC1/2/3/5,
// and APL-2546 AC2. Fixtures and cleanup use HTTP; no SQL aging or fake global Date.
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect as browserExpect } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const tag = `ZZ-TEST-2757-${Date.now()}-${process.pid}`;
const email = `nakul17+${tag.toLowerCase()}@aplyd.com`;
const password = "synthetic-clock-2757";
const clockSecret = "synthetic-clock-hmac-2757";
const jobSecret = "synthetic-clock-job-2757";
const day = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const headersAt = (now: number) => {
  const value = new Date(now).toISOString();
  return { "x-sho-test-now": value, "x-sho-test-clock-signature": createHmac("sha256", clockSecret).update(value).digest("hex") };
};
const logs = mkdtempSync(path.join(tmpdir(), "sho-2757-clock-"));
const processes: ChildProcess[] = [];
const projects: string[] = [];
let base: string;
let cookie = "";
let userId: string;
let organisationId: string;
let pipeline: { id: string; name: string; stages: { id: string; category: string }[] };

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function start(dev: boolean, enabled: boolean) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const fd = openSync(path.join(logs, `${dev ? "dev" : "production"}-${enabled}.log`), "a", 0o600);
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME,
    NODE_ENV: dev ? "development" : "production", DATABASE_URL: process.env.DATABASE_URL,
    DIRECT_DATABASE_URL: process.env.DATABASE_URL, APP_URL: url, EMAIL_OUTBOX_DIR: logs,
    SUPER_ADMIN_EMAILS: email, CRM_VISIBLE: "all", SEARCH_STAGE_A_ENABLED: "false",
    TEST_CLOCK: enabled ? "1" : "0", TEST_CLOCK_SECRET: clockSecret, JOB_SECRET: jobSecret,
    APLYD_ACCOUNTS_SSO: "false", NEXT_TELEMETRY_DISABLED: "1" };
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", dev ? "dev" : "start", "-H", "127.0.0.1", "-p", String(port)],
    { env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  processes.push(child);
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw new Error(`Clock test server exited; see ${logs}`);
    try { if ((await fetch(url + "/api/health", { signal: AbortSignal.timeout(2000) })).ok) return { child, url }; } catch { /* bounded startup */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Clock test server did not become healthy; see ${logs}`);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  try { process.kill(-child.pid!, "SIGTERM"); } catch { /* already exited */ }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, 5000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
  try { process.kill(-child.pid!, "SIGKILL"); } catch { /* no remaining children in this test's group */ }
}
async function call(route: string, method = "GET", body?: unknown, now?: number, status = 200, extra: Record<string, string> = {}) {
  const response = await fetch(base + route, { method, headers: { cookie, "content-type": "application/json", ...(now === undefined ? {} : headersAt(now)), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
  const text = await response.text();
  expect(response.status, `${method} ${route}: ${text}`).toBe(status);
  return { json: text ? JSON.parse(text) : null, response };
}
async function deal(label: string) {
  const result = await call("/api/deals", "POST", { name: `${tag} ${label}`, organisationId, pipelineId: pipeline.id, leaderId: userId,
    whyPursue: "Synthetic acceptance", need: "Synthetic need", serviceLine: "Synthetic", introducedBy: "Synthetic",
    value: 100, currency: "USD", probability: 50, expectedClose: day(90),
    nextStep: { title: `${tag} step ${label}`, dueDate: day(90) } }, undefined, 201);
  projects.push(result.json.deal.id);
  return result.json.deal.id as string;
}
async function list(id: string, now?: number) {
  return (await call("/api/deals", "GET", undefined, now)).json.deals.find((d: { id: string }) => d.id === id);
}
async function review(now?: number) { return (await call("/api/review", "GET", undefined, now)).json; }
async function move(id: string, category: string) {
  const project = (await call(`/api/projects/${id}`)).json.project;
  if (category === "LOST") {
    const taskId = project.deal.nextStep.id;
    const task = (await call(`/api/tasks/${taskId}`)).json.task;
    await call(`/api/tasks/${taskId}/complete`, "POST", { expectedUpdatedAt: task.updatedAt });
  }
  const stage = pipeline.stages.find((s) => s.category === category);
  expect(stage, `fixture pipeline has ${category}`).toBeTruthy();
  await call(`/api/projects/${id}/stage`, "POST", { stageId: stage!.id, expectedStageId: project.deal.stage.id, reason: "Synthetic acceptance" });
}

beforeAll(async () => {
  const db = new URL(process.env.DATABASE_URL ?? "");
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(db.hostname);
  expect(db.pathname).toMatch(/^\/sho_test(?:_[\w-]+)?$/);
  expect(existsSync(".next/BUILD_ID"), "fresh build is required for the production-ignore check").toBe(true);
  base = (await start(true, true)).url;
  await call("/api/auth/signup", "POST", { name: tag, email, password }, undefined, 201);
  const mail = readdirSync(logs).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(logs, f), "utf8"))).find((m) => m.to === email && /Verify/.test(m.subject));
  const token = mail?.text.match(/token=([\w-]+)/)?.[1];
  expect(token).toBeTruthy();
  await call("/api/auth/verify", "POST", { token });
  const signin = await call("/api/auth/signin", "POST", { email, password });
  cookie = signin.response.headers.getSetCookie().map((s) => s.split(";")[0]).find((s) => s.startsWith("sho_session="))!;
  userId = signin.json.user.id;
  expect(signin.json.user.orgRole).toBe("SUPER_ADMIN");
  organisationId = (await call("/api/orgs", "POST", { name: `${tag} buyer` }, undefined, 201)).json.organisation.id;
  pipeline = (await call("/api/deals/pipelines")).json.pipelines.find((p: { key: string }) => p.key === "DEAL_PROACTIVE");
}, 180000);

afterAll(async () => {
  try {
    if (cookie) {
      for (const id of projects) {
        const project = (await call(`/api/projects/${id}`)).json.project;
        if (!project.archived) await call(`/api/projects/${id}/archive`, "POST");
      }
      if (organisationId) await call(`/api/orgs/${organisationId}/archive`, "POST", { archive: true });
      await call("/api/profile/sessions/sign-out-others", "POST");
      await call("/api/auth/signout", "POST", undefined, undefined, 204);
    }
  } finally { for (const child of processes) await stop(child); }
}, 120000);

describe("SHO-2757 signed clock acceptance through the actual app", () => {
  it("APL-2543 AC1: list, detail and review use the same signed now without aging stored rows", async () => {
    const id = await deal("stalled read paths");
    const fresh = await list(id);
    expect(fresh.stalled).toBe(false);
    const future = Date.parse(fresh.lastActivity) + 31 * 86400000;
    expect((await list(id, future)).stalled).toBe(true);
    expect((await call(`/api/projects/${id}`, "GET", undefined, future)).json.project.deal.stalled).toBe(true);
    expect((await review(future)).stalled.some((d: { id: string }) => d.id === id)).toBe(true);
    expect((await list(id)).lastActivity).toBe(fresh.lastActivity);
    expect((await list(id)).stalled).toBe(false);
  });

  it("APL-2525 AC6 / APL-2543 AC3: actual stalled-deals job notifies the Leader once per stall", async () => {
    const id = await deal("one notice");
    const future = Date.parse((await list(id)).lastActivity) + 31 * 86400000;
    const count = async () => (await call("/api/notifications?limit=200")).json.items.filter((n: { text: string }) => n.text.includes(`${tag} one notice`) && n.text.includes("30 days")).length;
    expect(await count()).toBe(0);
    await call("/api/jobs/stalled-deals", "POST", {}, future, 200, { authorization: `Bearer ${jobSecret}` });
    expect(await count()).toBe(1);
    await call("/api/jobs/stalled-deals", "POST", {}, future, 200, { authorization: `Bearer ${jobSecret}` });
    expect(await count()).toBe(1);
  });

  it("APL-2543 AC2: new task activity clears the stalled flag at the same supplied time", async () => {
    const id = await deal("activity clears flag");
    const old = Date.parse((await list(id)).lastActivity);
    const future = old + 30 * 86400000 + 10;
    expect((await list(id, future)).stalled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, old + 30 - Date.now())));
    const project = (await call(`/api/projects/${id}`)).json.project;
    const taskId = project.deal.nextStep.id;
    const task = (await call(`/api/tasks/${taskId}`)).json.task;
    await call(`/api/tasks/${taskId}`, "PATCH", { title: `${tag} actual new activity`, expectedUpdatedAt: task.updatedAt });
    expect(Date.parse((await list(id)).lastActivity)).toBeGreaterThan(old + 10);
    expect((await list(id, future)).stalled).toBe(false);
    expect((await review(future)).stalled.some((d: { id: string }) => d.id === id)).toBe(false);
  });

  it("APL-2543 AC5: archived, Paused, Won and Lost deals never acquire a stalled flag", async () => {
    for (const category of ["PAUSED", "DONE", "LOST", "ARCHIVED"]) {
      const id = await deal(`excluded ${category}`);
      if (category === "ARCHIVED") await call(`/api/projects/${id}/archive`, "POST");
      else await move(id, category);
      const future = Date.now() + 32 * 86400000;
      const rows = (await call(category === "ARCHIVED" ? "/api/deals?archived=true" : "/api/deals", "GET", undefined, future)).json.deals;
      expect(rows.find((d: { id: string }) => d.id === id)?.stalled).toBe(false);
      expect((await review(future)).stalled.some((d: { id: string }) => d.id === id)).toBe(false);
    }
    await call("/api/jobs/stalled-deals", "POST", {}, Date.now() + 32 * 86400000, 200, { authorization: `Bearer ${jobSecret}` });
    const notices = (await call("/api/notifications?limit=200")).json.items;
    expect(notices.filter((n: { text: string }) => n.text.includes(`${tag} excluded`) && n.text.includes("30 days"))).toHaveLength(0);
  });

  it("APL-2546 AC2: an idea enters the review only after 30 days through signed reads", async () => {
    const p = (await call("/api/projects", "POST", { name: `${tag} ideas`, leaderId: userId }, undefined, 201)).json.project.id;
    projects.push(p);
    const id = (await call(`/api/projects/${p}/tasks`, "POST", { title: `${tag} old idea`, dueDate: day(90) }, undefined, 201)).json.task.id;
    await call(`/api/tasks/${id}/idea`, "POST", { isIdea: true });
    expect((await review()).ideas.some((t: { id: string }) => t.id === id)).toBe(false);
    expect((await review(Date.now() + 31 * 86400000)).ideas.some((t: { id: string }) => t.id === id)).toBe(true);
    expect((await review()).ideas.some((t: { id: string }) => t.id === id)).toBe(false);
  });

  for (const width of [1280, 390]) {
    it(`APL-2543 AC1 / APL-2546 AC2: actual ${width}px board, list, detail and review display the signed clock results`, async () => {
      const label = `browser ${width}`;
      const id = await deal(label);
      const future = Date.parse((await list(id)).lastActivity) + 31 * 86400000;
      const browser = await chromium.launch({ headless: true, ...(process.env.SHO_BROWSER_EXECUTABLE ? { executablePath: process.env.SHO_BROWSER_EXECUTABLE } : {}) });
      try {
        const context = await browser.newContext({ viewport: { width, height: 900 }, extraHTTPHeaders: headersAt(future) });
        expect((await context.request.post(base + "/api/auth/signin", { data: { email, password } })).status()).toBe(200);
        const page = await context.newPage();
        page.setDefaultTimeout(30000);
        await page.goto(base + "/deals");
        await page.getByRole("tab", { name: pipeline.name, exact: true }).click();
        const link = page.getByRole("link", { name: `${tag} ${label}`, exact: true });
        await browserExpect(link).toBeVisible();
        // Several deliberately aged fixtures are on this board. The target's
        // own row and detail flag are asserted separately below.
        await browserExpect(page.getByText("Stalled", { exact: true }).first()).toBeVisible();
        await page.getByRole("button", { name: "List", exact: true }).click();
        await browserExpect(page.getByRole("row").filter({ has: link })).toContainText("Stalled");
        if (process.env.SHO_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.SHO_EVIDENCE_DIR, `clock-list-${width}.png`), fullPage: true });
        await link.click();
        await browserExpect(page.getByText("Stalled · no activity for 30 days", { exact: true })).toBeVisible();
        if (process.env.SHO_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.SHO_EVIDENCE_DIR, `clock-detail-${width}.png`), fullPage: true });
        await page.goto(base + "/review");
        const row = page.getByRole("row").filter({ has: page.getByText(`${tag} ${label}`, { exact: true }) });
        await browserExpect(row).toContainText("Inactive 30+ days");
        await browserExpect(page.getByRole("row").filter({ has: page.getByText(`${tag} old idea`, { exact: true }) })).toContainText("Idea · 30+ days");
        if (process.env.SHO_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.SHO_EVIDENCE_DIR, `clock-review-${width}.png`), fullPage: true });
      } finally { await browser.close(); }
    });
  }

  it("production ignores even valid signed headers with TEST_CLOCK=1", async () => {
    const id = await deal("production refuses clock");
    const previous = base;
    const production = await start(false, true);
    try {
      base = production.url;
      expect((await list(id, Date.now() + 40 * 86400000)).stalled).toBe(false);
    } finally { base = previous; await stop(production.child); }
  });

  it("the development app ignores valid clock headers when TEST_CLOCK is off", async () => {
    const id = await deal("flag off refuses clock");
    await stop(processes[0]);
    base = (await start(true, false)).url;
    expect((await list(id, Date.now() + 40 * 86400000)).stalled).toBe(false);
  });
});
