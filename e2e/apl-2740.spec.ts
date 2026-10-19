// APL-2740. Playwright coverage for both acceptance criteria.
// One local `next start` with CRM_VISIBLE=admins. Production hosts are refused.
// ZZ-TEST names, nakul17+ aliases. qa:TC missing: no TC id has been assigned.
// Run: npm run test:e2e -- e2e/apl-2740.spec.ts
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { assertStoryTargetAllowed } from "../tests/e2e/base-url";
import { istDate, PW } from "../tests/helpers";

assertStoryTargetAllowed();

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const SPEND = "88001420.42";
const dealName = `ZZ-TEST Deal ${RUN}`;
const orgName = `ZZ-TEST Account ${RUN}`;
const plainName = `ZZ-TEST Shared ${RUN}`;
const stepTitle = `ZZ-TEST step ${RUN}`;
const whyPursue = `ZZ-TEST pursue ${RUN}`;
const OUTBOX = path.join("/tmp", `sho-2740-outbox-${process.pid}`);
const ROOT = process.cwd();

type Who = { id: string; email: string; name: string; cookie: string };

let browser: Browser;
let serverPid: number | undefined;
let base = "";
let member: Who;
let leader: Who;
let dealId = "";
let orgId = "";
let plainId = "";
const projectIds: string[] = [];
const people: Who[] = [];

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

function killServer() {
  const pid = serverPid;
  serverPid = undefined;
  if (!pid || pid === process.pid) return;
  try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
}

class Api {
  cookie = "";
  constructor(private origin: string) {}
  async call(method: string, p: string, body?: unknown) {
    const res = await fetch(this.origin + p, {
      method,
      headers: { "content-type": "application/json", ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get("set-cookie");
    if (set) this.cookie = set.split(";")[0];
    const text = await res.text();
    const json = text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : null;
    return { status: res.status, json, text };
  }
  get = (p: string) => this.call("GET", p);
  post = (p: string, b?: unknown) => this.call("POST", p, b ?? {});
  patch = (p: string, b?: unknown) => this.call("PATCH", p, b);
}

function verifyToken(email: string) {
  let files: string[] = [];
  try { files = readdirSync(OUTBOX).sort(); } catch { return null; }
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(OUTBOX, f), "utf8"))).filter((m) => m.to === email && /Verify/.test(m.subject));
  return mails.at(-1)?.text.match(/token=([\w-]+)/)?.[1] ?? null;
}

async function signUp(origin: string, name: string, email: string): Promise<Who> {
  const c = new Api(origin);
  const r = await c.post("/api/auth/signup", { name, email, password: PW });
  if (r.status === 201) {
    const token = verifyToken(email);
    expect(token, "verify token").toBeTruthy();
    expect((await c.post("/api/auth/verify", { token })).status).toBe(200);
  } else {
    expect(r.status).toBe(409);
  }
  const s = await c.post("/api/auth/signin", { email, password: PW });
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  const who = { id: s.json.user.id as string, email, name, cookie: c.cookie };
  people.push(who);
  return who;
}

async function waitForHealth(port: number, proc: ChildProcess) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`CRM_VISIBLE=admins server exited ${proc.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`CRM_VISIBLE=admins server did not answer on port ${port}`);
}

async function startServer() {
  if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    throw new Error("CRM_VISIBLE=admins server cannot start: the production build is missing (.next/BUILD_ID)");
  }
  mkdirSync(OUTBOX, { recursive: true });
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      CRM_VISIBLE: "admins",
      EMAIL_OUTBOX_DIR: OUTBOX,
      SUPER_ADMIN_EMAILS: "root.test@aplyd.com",
      APP_URL: `http://127.0.0.1:${port}`,
      TASKBOARD_URL: `http://127.0.0.1:${port}`,
      NODE_ENV: "production",
    },
    stdio: "ignore",
  });
  if (!proc.pid) throw new Error("CRM_VISIBLE=admins server cannot start");
  serverPid = proc.pid;
  try {
    await waitForHealth(port, proc);
  } catch (err) {
    killServer();
    throw err;
  }
  base = `http://127.0.0.1:${port}`;
}

function assertNoCrm(text: string) {
  for (const needle of [dealName, dealId, orgName, orgId, stepTitle, whyPursue, SPEND, "Proactive"]) {
    expect(text, needle).not.toContain(needle);
  }
  expect(text).not.toContain(`/projects/${dealId}`);
  expect(text).not.toContain("/deals/");
  expect(text).not.toContain("/accounts/");
  expect(text).not.toContain(`"deals"`);
  expect(text).not.toContain(`"accounts"`);
  expect(text).not.toContain(`"spend"`);
}

async function signedPage(who: Who) {
  const ctx: BrowserContext = await browser.newContext({ baseURL: base });
  const signed = await ctx.request.post("/api/auth/signin", { data: { email: who.email, password: PW } });
  expect(signed.ok(), "sign in").toBe(true);
  const page = await ctx.newPage();
  return { ctx, page };
}

describe("qa:TC missing APL-2740 getPerson in the browser", () => {
  beforeAll(async () => {
    await startServer();
    browser = await chromium.launch({
      executablePath: process.env.PW_CHROMIUM || "/usr/bin/google-chrome",
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    const sa = await signUp(base, "Root", "root.test@aplyd.com");
    member = await signUp(base, `ZZ-TEST member ${RUN}`, `nakul17+zz-2740-pw-${RUN}-m@aplyd.com`);
    leader = await signUp(base, `ZZ-TEST admin ${RUN}`, `nakul17+zz-2740-pw-${RUN}-a@aplyd.com`);
    const adminApi = new Api(base);
    adminApi.cookie = sa.cookie;
    expect((await adminApi.patch(`/api/team/${leader.id}`, { orgRole: "ADMIN" })).status).toBe(200);
    const pipes = await adminApi.get("/api/deals/pipelines");
    expect(pipes.status, JSON.stringify(pipes.json)).toBe(200);
    const pipe = (pipes.json.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
    expect(pipe?.id).toBeTruthy();
    const org = await adminApi.post("/api/orgs", { name: orgName });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    orgId = org.json.organisation.id as string;
    const made = await adminApi.post("/api/deals", {
      name: dealName,
      organisationId: orgId,
      pipelineId: pipe!.id,
      leaderId: leader.id,
      whyPursue,
      value: Number(SPEND),
      currency: "USD",
      nextStep: { title: stepTitle, dueDate: istDate(3) },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    dealId = made.json.deal.id as string;
    projectIds.push(dealId);
    expect((await adminApi.post(`/api/projects/${dealId}/members`, { userId: member.id, role: "EDITOR" })).status).toBe(201);
    const plain = await adminApi.post("/api/projects", { name: plainName, leaderId: leader.id });
    expect(plain.status, JSON.stringify(plain.json)).toBe(201);
    plainId = plain.json.project.id as string;
    projectIds.push(plainId);
    const leaderApi = new Api(base);
    leaderApi.cookie = leader.cookie;
    expect((await leaderApi.post(`/api/projects/${plainId}/members`, { userId: member.id, role: "EDITOR" })).status).toBe(201);
  }, 180_000);

  afterAll(async () => {
    await browser?.close();
    const sa = new Api(base || "http://127.0.0.1");
    if (base) {
      const signed = await sa.post("/api/auth/signin", { email: "root.test@aplyd.com", password: PW });
      if (signed.status === 200) {
        for (const id of projectIds) {
          await sa.post(`/api/projects/${id}/members`, { userId: signed.json.user.id, role: "EDITOR" });
          await sa.post(`/api/projects/${id}/leader`, { newLeaderId: signed.json.user.id, previousRole: "EDITOR" });
          await sa.post(`/api/projects/${id}/archive`);
        }
        for (const who of people) {
          if (who.email === "root.test@aplyd.com") continue;
          await sa.post(`/api/team/${who.id}/deactivate`, { reassign: "leaders" });
        }
      }
    }
    killServer();
  });

  it("qa:TC missing AC1 a member person page and API response omit CRM fields", async () => {
    const { ctx, page } = await signedPage(member);
    try {
      for (const target of [leader, member]) {
        const res = await ctx.request.get(`/api/team/${target.id}`);
        expect(res.status()).toBe(200);
        const text = await res.text();
        assertNoCrm(text);
        const person = (await res.json()).person as { projects: { id: string; name: string }[] };
        expect(person.projects).toEqual([{ id: plainId, name: plainName }]);
        await page.goto(`/team/${target.id}`, { waitUntil: "domcontentloaded" });
        await page.getByRole("link", { name: plainName }).waitFor({ state: "visible" });
        const main = await page.locator("main").innerText();
        const html = await page.locator("main").innerHTML();
        expect(main).toContain(plainName);
        expect(main).toContain("Projects you share");
        assertNoCrm(main);
        assertNoCrm(html);
      }
    } finally {
      await ctx.close();
    }
  });

  it("qa:TC missing AC2 an admin person page and API response still show the deal", async () => {
    const { ctx, page } = await signedPage(leader);
    try {
      const res = await ctx.request.get(`/api/team/${leader.id}`);
      expect(res.status()).toBe(200);
      const text = await res.text();
      expect(text).toContain(dealName);
      expect(text).toContain(dealId);
      const person = (await res.json()).person as { projects: { id: string; name: string; role: string; openTasks: number }[]; openTasks: number };
      expect(person.projects).toContainEqual(expect.objectContaining({ id: dealId, name: dealName, role: "LEADER", openTasks: 1 }));
      expect(person.projects).toContainEqual(expect.objectContaining({ id: plainId, name: plainName, role: "LEADER" }));
      await page.goto(`/team/${leader.id}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("link", { name: dealName }).waitFor({ state: "visible" });
      await page.getByRole("link", { name: plainName }).waitFor({ state: "visible" });
      const main = await page.locator("main").innerText();
      expect(main).toContain(dealName);
      expect(main).toContain(plainName);
      const href = await page.getByRole("link", { name: dealName }).getAttribute("href");
      expect(href).toBe(`/projects/${dealId}`);
    } finally {
      await ctx.close();
    }
  });
});
