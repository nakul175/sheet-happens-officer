// APL-2658. Each CRM_VISIBLE mode is its own `next start` process and its own environment.
// Michael's scenario names the open mode `on`. crmMode() treats every value other than `admins` and `off`
// as everyone, so the server for that row is started with CRM_VISIBLE=on.
// Run with `npm run test:crm-modes` after `npm run build`. `npm test` does not start these servers.
// A missing build, or a mode that never answers /api/health, fails this file.
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { QUICK_ACTIONS } from "../src/lib/concierge/reads";
import { istDate, PW } from "./helpers";

const root = fileURLToPath(new URL("..", import.meta.url));
// Run-scoped so a shared test database cannot mix this seed with another spec's "Acme renewal".
const runId = `${Date.now().toString(36)}-${process.pid}`;
const tag = `ZZ-TEST-${runId}`;
const dealName = `Acme renewal ${tag}`;
const MODES = ["on", "admins", "off"] as const;
type Mode = (typeof MODES)[number];

type Running = {
  mode: Mode;
  port: number;
  pid: number;
  outbox: string;
  /** The object passed to spawn. Each mode gets its own. */
  env: NodeJS.ProcessEnv;
  base: string;
};

const running = new Map<Mode, Running>();
const seed: { userIds: string[]; emails: string[]; projectId?: string; projectIds: string[]; orgId?: string; orgIds: string[] } = {
  userIds: [], emails: [], projectIds: [], orgIds: [],
};

/** Removes this run's users, deal and organisation so the shared test database stays clear. */
async function cleanupSeed() {
  const users = seed.emails.length || seed.userIds.length
    ? await db.user.findMany({
      where: { OR: [{ id: { in: seed.userIds } }, { email: { in: seed.emails } }] },
      select: { id: true },
    })
    : [];
  const userIds = users.map((user) => user.id);
  const projectIds = [...new Set([...(seed.projectId ? [seed.projectId] : []), ...seed.projectIds])];
  const orgIds = [...new Set([...(seed.orgId ? [seed.orgId] : []), ...seed.orgIds])];
  if (userIds.length) {
    await db.modelUsage.deleteMany({ where: { userId: { in: userIds } } });
    await db.actionLog.deleteMany({
      where: { OR: [{ actorId: { in: userIds } }, ...(projectIds.length ? [{ projectId: { in: projectIds } }] : [])] },
    });
    await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  } else if (projectIds.length) {
    await db.actionLog.deleteMany({ where: { projectId: { in: projectIds } } });
  }
  if (projectIds.length) await db.project.deleteMany({ where: { id: { in: projectIds } } });
  if (orgIds.length) await db.organisation.deleteMany({ where: { id: { in: orgIds } } });
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
    if (exited || child.exitCode !== null) {
      throw new Error(`CRM_VISIBLE mode cannot start (${exited ?? `exited ${child.exitCode}`})`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch { /* still booting */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`CRM_VISIBLE mode cannot start (no healthy response on port ${port})`);
}

/** Starts one mode. Throws, and stops the process, when that mode cannot start. */
async function startModeServer(mode: Mode, opts: { bin?: string; args?: string[]; timeoutMs?: number } = {}): Promise<Running> {
  const port = await freePort();
  const outbox = mkdtempSync(path.join(tmpdir(), `sho-crm-${mode}-`));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    CRM_VISIBLE: mode,
    EMAIL_OUTBOX_DIR: outbox,
    APP_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
    SUPER_ADMIN_EMAILS: "root.test@aplyd.com",
    JOB_SECRET: process.env.JOB_SECRET || "replace-with-a-token-of-at-least-16-chars",
  };
  const bin = opts.bin ?? "npx";
  const args = opts.args ?? ["next", "start", "-H", "127.0.0.1", "-p", String(port)];
  const logFd = openSync(path.join(outbox, "server.log"), "a");
  const child = spawn(bin, args, { cwd: root, env, detached: true, stdio: ["ignore", logFd, logFd] });
  closeSync(logFd);
  child.unref();
  try {
    await waitForHealth(port, child, opts.timeoutMs ?? 60_000);
  } catch (err) {
    killGroup(child.pid);
    const log = existsSync(path.join(outbox, "server.log")) ? scrub(readFileSync(path.join(outbox, "server.log"), "utf8")).slice(-1500) : "";
    const message = err instanceof Error ? err.message : `CRM_VISIBLE=${mode} cannot start`;
    throw new Error(`${message}${log ? `\n${log}` : ""}`);
  }
  if (!child.pid) throw new Error(`CRM_VISIBLE=${mode} cannot start`);
  return { mode, port, pid: child.pid, outbox, env, base: `http://127.0.0.1:${port}` };
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
  const files = readdirSync(outbox).filter((f) => f.endsWith(".json")).sort();
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(outbox, f), "utf8")) as { to?: string; subject?: string; text?: string });
  const mine = mails.filter((m) => m.to === email && /Verify/.test(m.subject ?? ""));
  return mine.at(-1)?.text?.match(/token=([\w-]+)/)?.[1] ?? null;
}

async function signIn(server: Running, name: string, email: string) {
  const created = await call(server.base, "", "POST", "/api/auth/signup", { name, email, password: PW });
  if (created.status === 201) {
    const token = verifyToken(server.outbox, email);
    expect(token, `verification mail for ${email}`).toBeTruthy();
    expect((await call(server.base, "", "POST", "/api/auth/verify", { token })).status).toBe(200);
  } else {
    expect(created.status, created.text).toBe(409);
  }
  const signed = await call(server.base, "", "POST", "/api/auth/signin", { email, password: PW });
  expect(signed.status, signed.text).toBe(200);
  const user = signed.json?.user as { id: string } | undefined;
  expect(user?.id).toBeTruthy();
  expect(signed.cookie).toContain("sho_session=");
  return { id: user!.id, cookie: signed.cookie, name };
}

type Read = { name: string; status: number; text: string; hiddenStatus: number; mustName: boolean };

/** My tasks, search, the bell, every concierge quick action, and the deal API. */
async function readPaths(base: string, cookie: string, dealId: string, name: string): Promise<Read[]> {
  const my = await call(base, cookie, "GET", "/api/my-tasks");
  const search = await call(base, cookie, "GET", `/api/search?q=${encodeURIComponent(name)}`);
  const bell = await call(base, cookie, "GET", "/api/notifications");
  const quicks = [];
  for (const q of QUICK_ACTIONS) quicks.push(await call(base, cookie, "POST", `/api/concierge/quick/${q.id}`, {}));
  const list = await call(base, cookie, "GET", "/api/deals");
  const one = await call(base, cookie, "GET", `/api/projects/${dealId}`);
  const quickStatus = quicks.every((q) => q.status === 200) ? 200 : quicks.find((q) => q.status !== 200)!.status;
  const dealStatus = list.status === one.status ? list.status : 0;
  return [
    { name: "My tasks", status: my.status, text: my.text, hiddenStatus: 200, mustName: true },
    { name: "search", status: search.status, text: search.text, hiddenStatus: 200, mustName: true },
    { name: "the bell", status: bell.status, text: bell.text, hiddenStatus: 200, mustName: false },
    { name: "the concierge quick actions", status: quickStatus, text: quicks.map((q) => q.text).join("\n"), hiddenStatus: 200, mustName: true },
    { name: "the deal API", status: dealStatus, text: `${list.text}\n${one.text}`, hiddenStatus: 404, mustName: true },
  ];
}

function listeningPids(port: number) {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  const inodes = new Set<string>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 10 || parts[3] !== "0A") continue;
      if ((parts[1].split(":").pop() ?? "").toUpperCase() === hexPort) inodes.add(parts[9]);
    }
  }
  if (!inodes.size) return [];
  const found: number[] = [];
  for (const dir of readdirSync("/proc")) {
    if (!/^\d+$/.test(dir)) continue;
    let fds: string[];
    try { fds = readdirSync(`/proc/${dir}/fd`); } catch { continue; }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${dir}/fd/${fd}`);
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        if (inode && inodes.has(inode)) { found.push(Number(dir)); break; }
      } catch { /* fd vanished */ }
    }
  }
  return found;
}

function isInGroup(ancestor: number, pid: number) {
  let cur = pid;
  const seen = new Set<number>();
  while (cur > 1 && !seen.has(cur)) {
    if (cur === ancestor) return true;
    seen.add(cur);
    let stat = "";
    try { stat = readFileSync(`/proc/${cur}/stat`, "utf8"); } catch { return false; }
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!ppid) return false;
    cur = ppid;
  }
  return false;
}

describe("CRM_VISIBLE modes are tested against a real server per mode", () => {
  beforeAll(async () => {
    if (!existsSync(path.join(root, ".next", "BUILD_ID"))) {
      throw new Error("CRM_VISIBLE mode cannot start: the production build is missing (.next/BUILD_ID)");
    }
    await Promise.all(MODES.map(async (mode) => {
      const server = await startModeServer(mode);
      running.set(server.mode, server);
    }));
  }, 180_000);

  afterAll(async () => {
    try { await cleanupSeed(); } finally {
      for (const server of running.values()) killGroup(server.pid);
      await db.$disconnect();
    }
  });

  it("Hidden deals stay hidden through every read path", async () => {
    const open = running.get("on");
    expect(open, "the on server is running").toBeTruthy();
    const memberEmail = `member.${tag}@aplyd.com`.toLowerCase();
    const adminEmail = `admin.${tag}@aplyd.com`.toLowerCase();
    seed.emails.push(memberEmail, adminEmail);
    const member = await signIn(open!, `member ${tag}`, memberEmail);
    const admin = await signIn(open!, `admin ${tag}`, adminEmail);
    seed.userIds.push(member.id, admin.id);
    // Role lives on the user row, which every mode's server reads. Skip the shared Super Admin account.
    await db.user.update({ where: { id: admin.id }, data: { orgRole: "ADMIN" } });

    const pipes = await call(open!.base, member.cookie, "GET", "/api/deals/pipelines");
    expect(pipes.status, pipes.text).toBe(200);
    const pipelines = pipes.json?.pipelines as { id: string; key: string }[];
    const pipe = pipelines.find((p) => p.key === "DEAL_PROACTIVE");
    expect(pipe?.id).toBeTruthy();
    const org = await call(open!.base, member.cookie, "POST", "/api/orgs", { name: `Buyer ${tag}` });
    expect(org.status, org.text).toBe(201);
    const organisationId = (org.json?.organisation as { id: string }).id;
    seed.orgId = organisationId;
    const made = await call(open!.base, member.cookie, "POST", "/api/deals", {
      name: dealName, organisationId, pipelineId: pipe!.id, leaderId: member.id, whyPursue: tag,
      nextStep: { title: `Send the pack ${tag}`, dueDate: istDate(2) },
    });
    expect(made.status, made.text).toBe(201);
    const dealId = (made.json?.deal as { id: string; name: string }).id;
    seed.projectId = dealId;
    expect((made.json?.deal as { name: string }).name).toBe(dealName);
    const task = await db.task.findFirst({ where: { projectId: dealId, deletedAt: null }, select: { id: true } });
    expect(task?.id).toBeTruthy();
    // Membership only, with no bell row: a notice would store the deal name, and the bell does not filter those.
    await db.projectMember.create({ data: { projectId: dealId, userId: admin.id, role: "EDITOR" } });
    await db.taskCollaborator.create({ data: { taskId: task!.id, userId: admin.id } });

    const people = { member, admin };
    const examples: { mode: Mode; user: "member" | "admin"; visible: boolean }[] = [
      { mode: "on", user: "member", visible: true },
      { mode: "admins", user: "member", visible: false },
      { mode: "admins", user: "admin", visible: true },
      { mode: "off", user: "admin", visible: false },
    ];
    for (const example of examples) {
      const server = running.get(example.mode)!;
      const who = people[example.user];
      const label = `mode=${example.mode} user=${example.user} visible=${example.visible ? "yes" : "no"}`;
      const reads = await readPaths(server.base, who.cookie, dealId, dealName);
      for (const read of reads) {
        const wanted = example.visible ? 200 : read.hiddenStatus;
        expect(read.status, `${label} ${read.name}`).toBe(wanted);
        if (!example.visible || read.mustName) {
          if (example.visible) expect(read.text, `${label} ${read.name}`).toContain(dealName);
          else expect(read.text, `${label} ${read.name}`).not.toContain(dealName);
        }
      }
      const joined = reads.map((read) => read.text).join("\n");
      if (example.visible) expect(joined, label).toContain(dealName);
      else expect(joined, label).not.toContain(dealName);
    }
  }, 120_000);

  it("Each mode runs in its own server process", async () => {
    expect([...running.keys()].sort()).toEqual([...MODES].sort());
    const pids = [...running.values()].map((server) => server.pid);
    expect(new Set(pids).size, "each mode has its own process").toBe(MODES.length);
    expect(pids.every((pid) => pid !== process.pid)).toBe(true);
    const envs = [...running.values()].map((server) => server.env);
    expect(new Set(envs).size, "each mode has its own env object").toBe(MODES.length);

    // Mode, outbox and base are the values passed to spawn. The deal API is how that mode shows up.
    const open = running.get("on");
    expect(open, "the on server is running").toBeTruthy();
    const memberEmail = `nakul17+zz-2728-${runId}-mode-member@aplyd.com`;
    const adminEmail = `nakul17+zz-2728-${runId}-mode-admin@aplyd.com`;
    seed.emails.push(memberEmail, adminEmail);
    const member = await signIn(open!, `ZZ-TEST mode member ${runId}`, memberEmail);
    const admin = await signIn(open!, `ZZ-TEST mode admin ${runId}`, adminEmail);
    seed.userIds.push(member.id, admin.id);
    await db.user.update({ where: { id: admin.id }, data: { orgRole: "ADMIN" } });

    const listeners: number[] = [];
    for (const server of running.values()) {
      expect(server.env.CRM_VISIBLE).toBe(server.mode);
      expect(server.env.EMAIL_OUTBOX_DIR).toBe(server.outbox);
      expect(server.env.APP_URL).toBe(server.base);
      const health = await fetch(`${server.base}/api/health`);
      expect(health.status, server.mode).toBe(200);
      const memberDeals = await call(server.base, member.cookie, "GET", "/api/deals");
      const adminDeals = await call(server.base, admin.cookie, "GET", "/api/deals");
      const memberSees = memberDeals.status === 200;
      const adminSees = adminDeals.status === 200;
      const observed = memberSees && adminSees ? "on" : !memberSees && adminSees ? "admins" : !memberSees && !adminSees ? "off" : "mixed";
      expect(observed, `${server.mode} member ${memberDeals.status} admin ${adminDeals.status}`).toBe(server.mode);
      const listening = listeningPids(server.port);
      expect(listening.length, `${server.mode} is listening`).toBeGreaterThan(0);
      for (const pid of listening) {
        expect(isInGroup(server.pid, pid), `${server.mode} listener ${pid} belongs to ${server.pid}`).toBe(true);
      }
      listeners.push(...listening);
    }
    expect(new Set(listeners).size, "no mode reuses another mode's process").toBe(listeners.length);
    const modes = new Set([...running.values()].map((server) => server.mode));
    expect(modes).toEqual(new Set(MODES));

    await expect(startModeServer("on", { bin: process.execPath, args: ["-e", "process.exit(1)"], timeoutMs: 3_000 })).rejects.toThrow(/cannot start/);
    await expect(startModeServer("off", { bin: process.execPath, args: ["-e", "setInterval(() => {}, 1e9)"], timeoutMs: 800 })).rejects.toThrow(/cannot start/);
  }, 60_000);

  it("qa:TC-APL2728-968d706d@v1 AC4: the person page redacts a hidden deal under every mode", async () => {
    const open = running.get("on");
    expect(open, "the on server is running").toBeTruthy();
    const dealName = "ZZ-TEST Acme renewal";
    const taskTitle = "ZZ-TEST Acme kickoff";
    const plainName = `ZZ-TEST Shared ${tag}`;
    const memberEmail = `nakul17+zz-2728-${runId}-member@aplyd.com`;
    const adminEmail = `nakul17+zz-2728-${runId}-admin@aplyd.com`;
    seed.emails.push(memberEmail, adminEmail);
    const member = await signIn(open!, `ZZ-TEST member ${runId}`, memberEmail);
    const admin = await signIn(open!, `ZZ-TEST admin ${runId}`, adminEmail);
    seed.userIds.push(member.id, admin.id);
    await db.user.update({ where: { id: admin.id }, data: { orgRole: "ADMIN" } });

    const pipes = await call(open!.base, admin.cookie, "GET", "/api/deals/pipelines");
    expect(pipes.status, pipes.text).toBe(200);
    const pipe = (pipes.json?.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
    expect(pipe?.id).toBeTruthy();
    const org = await call(open!.base, admin.cookie, "POST", "/api/orgs", { name: `ZZ-TEST Buyer ${tag}` });
    expect(org.status, org.text).toBe(201);
    const organisationId = (org.json?.organisation as { id: string }).id;
    seed.orgIds.push(organisationId);
    // Member A is an editor. The admin leads the deal, so it shows on GET /api/team/<adminId>.
    const made = await call(open!.base, admin.cookie, "POST", "/api/deals", {
      name: dealName, organisationId, pipelineId: pipe!.id, leaderId: admin.id, whyPursue: tag,
      nextStep: { title: taskTitle, dueDate: istDate(3) },
    });
    expect(made.status, made.text).toBe(201);
    const dealId = (made.json?.deal as { id: string }).id;
    seed.projectIds.push(dealId);
    expect((await call(open!.base, admin.cookie, "POST", `/api/projects/${dealId}/members`, { userId: member.id, role: "EDITOR" })).status).toBe(201);
    const plain = await call(open!.base, admin.cookie, "POST", "/api/projects", { name: plainName, leaderId: admin.id });
    expect(plain.status, plain.text).toBe(201);
    const plainId = (plain.json?.project as { id: string }).id;
    seed.projectIds.push(plainId);
    expect((await call(open!.base, admin.cookie, "POST", `/api/projects/${plainId}/members`, { userId: member.id, role: "EDITOR" })).status).toBe(201);
    expect((await call(open!.base, admin.cookie, "POST", `/api/projects/${plainId}/tasks`, { title: `ZZ-TEST Shared task ${tag}`, assigneeId: admin.id })).status).toBe(201);
    const stage = await db.project.findUnique({ where: { id: dealId }, select: { stage: { select: { name: true } } } });
    const stageName = stage?.stage?.name ?? "";
    expect(stageName).toBeTruthy();

    const hiddenLabel = "A deal you can't view.";
    const assertHidden = (text: string, json: Record<string, unknown> | null) => {
      expect(text).not.toContain(dealName);
      expect(text).not.toContain(dealId);
      expect(text).not.toContain(`/projects/${dealId}`);
      expect(text).not.toContain(taskTitle);
      expect(text).not.toContain(stageName);
      const projects = ((json?.person as { projects?: { id?: string; name?: string; href?: null }[] })?.projects) ?? [];
      expect(projects.filter((p) => p.href === null)).toEqual([{ name: hiddenLabel, href: null }]);
      expect(projects.filter((p) => p.name === hiddenLabel)).toHaveLength(1);
      expect(projects.some((p) => p.id === dealId)).toBe(false);
      expect(projects.some((p) => p.id === plainId)).toBe(true);
    };
    const assertVisible = (text: string) => {
      expect(text).toContain(dealName);
      expect(text).toContain(dealId);
      expect(text).not.toContain(hiddenLabel);
    };

    let allServer: Running | undefined;
    try {
      allServer = await startModeServer("all" as Mode);
      // Member path is GET /api/team/<adminId> as the editor. Admin path is the same URL as the admin.
      const cases: { mode: string; server: Running; user: "member" | "admin"; path: "member" | "admin"; hidden: boolean }[] = [
        { mode: "on", server: open!, user: "member", path: "member", hidden: false },
        { mode: "on", server: open!, user: "admin", path: "admin", hidden: false },
        { mode: "all", server: allServer, user: "member", path: "member", hidden: false },
        { mode: "all", server: allServer, user: "admin", path: "admin", hidden: false },
        { mode: "admins", server: running.get("admins")!, user: "member", path: "member", hidden: true },
        { mode: "admins", server: running.get("admins")!, user: "admin", path: "admin", hidden: false },
        { mode: "off", server: running.get("off")!, user: "member", path: "member", hidden: true },
        { mode: "off", server: running.get("off")!, user: "admin", path: "admin", hidden: true },
      ];
      const people = { member, admin };
      const hiddenAtOne = new Map<string, unknown>();
      for (const example of cases) {
        const who = people[example.user];
        const res = await call(example.server.base, who.cookie, "GET", `/api/team/${admin.id}`);
        const label = `CRM_VISIBLE=${example.mode} ${example.path} path`;
        expect(res.status, `${label} ${res.text}`).toBe(200);
        if (example.hidden) {
          assertHidden(res.text, res.json);
          hiddenAtOne.set(`${example.mode}:${example.path}`, res.json?.person);
        } else assertVisible(res.text);
        if (example.path === "admin" && example.mode === "off") {
          expect((res.json?.person as { openTasks?: number }).openTasks).toBe(1);
        }
        if (example.path === "admin" && example.mode === "admins") {
          expect((res.json?.person as { openTasks?: number }).openTasks).toBe(2);
        }
      }

      // Admin viewing a non-admin rep under off. The rep has one plain task and one deal task.
      const offServer = running.get("off")!;
      expect((await call(open!.base, admin.cookie, "POST", `/api/projects/${dealId}/tasks`, { title: `ZZ-TEST Rep deal ${tag}`, assigneeId: member.id })).status).toBe(201);
      expect((await call(open!.base, admin.cookie, "POST", `/api/projects/${plainId}/tasks`, { title: `ZZ-TEST Rep plain ${tag}`, assigneeId: member.id })).status).toBe(201);
      const repAtOne = await call(offServer.base, admin.cookie, "GET", `/api/team/${member.id}`);
      expect(repAtOne.status, repAtOne.text).toBe(200);
      assertHidden(repAtOne.text, repAtOne.json);
      const repPerson = repAtOne.json?.person as { id?: string; email?: string; openTasks?: number };
      expect(repPerson.id).toBe(member.id);
      expect(repPerson.email).toBe(memberEmail);
      expect(repPerson.openTasks).toBe(1);
      expect(repAtOne.text).not.toContain(`ZZ-TEST Rep deal ${tag}`);

      // 1, 2 and 5 hidden deals must be the same sentence. 0 hidden deals adds nothing.
      const hiddenCases = cases.filter((example) => example.hidden);
      const addDeal = async (name: string) => {
        const made = await call(open!.base, admin.cookie, "POST", "/api/deals", {
          name, organisationId, pipelineId: pipe!.id, leaderId: admin.id, whyPursue: tag,
          nextStep: { title: `${name} step`, dueDate: istDate(3) },
        });
        expect(made.status, made.text).toBe(201);
        const id = (made.json?.deal as { id: string }).id;
        seed.projectIds.push(id);
        expect((await call(open!.base, admin.cookie, "POST", `/api/projects/${id}/members`, { userId: member.id, role: "EDITOR" })).status).toBe(201);
      };
      const expectSameHidden = async (count: number) => {
        for (const example of hiddenCases) {
          const res = await call(example.server.base, people[example.user].cookie, "GET", `/api/team/${admin.id}`);
          expect(res.status, `${count} deals ${example.mode} ${example.path} ${res.text}`).toBe(200);
          expect(res.json?.person).toEqual(hiddenAtOne.get(`${example.mode}:${example.path}`));
          assertHidden(res.text, res.json);
        }
        const rep = await call(offServer.base, admin.cookie, "GET", `/api/team/${member.id}`);
        expect(rep.status, `${count} deals admin viewing rep ${rep.text}`).toBe(200);
        expect(rep.json?.person).toEqual(repAtOne.json?.person);
        assertHidden(rep.text, rep.json);
      };
      await addDeal(`ZZ-TEST Acme two ${tag}`);
      await expectSameHidden(2);
      await addDeal(`ZZ-TEST Acme three ${tag}`);
      await addDeal(`ZZ-TEST Acme four ${tag}`);
      await addDeal(`ZZ-TEST Acme five ${tag}`);
      await expectSameHidden(5);

      const plainOnlyEmail = `nakul17+zz-2728-${runId}-plain@aplyd.com`;
      seed.emails.push(plainOnlyEmail);
      const plainOnly = await signIn(open!, `ZZ-TEST plain ${runId}`, plainOnlyEmail);
      seed.userIds.push(plainOnly.id);
      expect((await call(open!.base, admin.cookie, "POST", `/api/projects/${plainId}/members`, { userId: plainOnly.id, role: "EDITOR" })).status).toBe(201);
      for (const mode of ["admins", "off"] as const) {
        const server = running.get(mode)!;
        for (const who of [member, admin]) {
          const res = await call(server.base, who.cookie, "GET", `/api/team/${plainOnly.id}`);
          expect(res.status, res.text).toBe(200);
          expect(res.text).not.toContain(hiddenLabel);
          expect(res.text).not.toContain(dealName);
          const projects = ((res.json?.person as { projects?: { href?: null }[] }).projects) ?? [];
          expect(projects.some((p) => p.href === null)).toBe(false);
        }
      }

      const admins = running.get("admins")!;
      const started = Date.now();
      const burst = await Promise.all(Array.from({ length: 48 }, () => call(admins.base, member.cookie, "GET", `/api/team/${admin.id}`)));
      const ms = Date.now() - started;
      expect(burst).toHaveLength(48);
      for (const res of burst) {
        expect(res.status).toBe(200);
        assertHidden(res.text, res.json);
      }
      console.log(`APL-2728 load: 48 concurrent GET /api/team/:id on CRM_VISIBLE=admins in ${ms}ms`);
    } finally {
      if (allServer) killGroup(allServer.pid);
    }
  }, 120_000);
});
