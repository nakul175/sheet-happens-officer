// APL-2729 AC4. Each CRM_VISIBLE mode is its own `next start` process, started with that mode's env.
// unset deletes CRM_VISIBLE. all, admins and off set it. The test process never switches a running server.
// POST /api/jobs/reminders uses a test-only token defined here. A short or missing parent JOB_SECRET
// does not skip this file: the child always receives the test token, and a dead server fails the run.
// Rows are checked in the local test database and on GET /api/notifications. Names are ZZ-TEST.
//
// qa:TC missing unset
// qa:TC missing all
// qa:TC missing admins / member
// qa:TC missing admins / admin
// qa:TC missing off
// qa:TC missing non-deal ops check
// qa:TC missing 40 concurrent reminder requests
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { istDate, PW } from "./helpers";
import { assertProcfs } from "./procfs-precondition";

const root = fileURLToPath(new URL("..", import.meta.url));
const LOAD = 40;
const DUE = ["TASK_DUE_TOMORROW", "TASK_DUE_TODAY", "TASK_OVERDUE"] as const;
/** Fake token for the spawned servers only. Never a real job secret, and never printed. */
const TEST_JOB_SECRET = "test-only-job-secret-012345";

type Mode = "unset" | "all" | "admins" | "off";

const runId = `${Date.now().toString(36)}-${process.pid}`;
const tag = `ZZ-TEST-${runId}`;
const dealName = `ZZ-TEST Acme renewal ${tag}`;
const memberTitle = `ZZ-TEST Acme kickoff ${tag}`;
const adminTitle = `ZZ-TEST Acme kickoff ${tag} admin`;
const opsTitle = `ZZ-TEST Ops check ${tag}`;

type Running = { mode: Mode; port: number; pid: number; outbox: string; base: string };
type Who = { id: string; cookie: string };

const spawned = new Set<number>();
let member: Who;
let dealAdmin: Who;
let dealId = "";
let opsProjectId = "";
let memberTaskId = "";
let adminTaskId = "";
let opsTaskId = "";

function assertLocalTestDatabase() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required and must point at the local test database");
  let host = "";
  try {
    host = new URL(raw.replace(/^postgres(ql)?:/i, "http:")).hostname;
  } catch {
    throw new Error("DATABASE_URL must point at the local test database");
  }
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Refusing to run: reminder tests use the local test database only");
  }
}

function scrub(text: string) {
  return text
    .replaceAll(TEST_JOB_SECRET, "[redacted]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgresql://[redacted]")
    .replace(/(password|secret|token|api_key)(["'=:\s]+)(\S+)/gi, "$1$2[redacted]");
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

function descendantPids(rootPid: number) {
  const children = new Map<number, number[]>();
  for (const dir of readdirSync("/proc")) {
    if (!/^\d+$/.test(dir)) continue;
    const pid = Number(dir);
    let stat = "";
    try { stat = readFileSync(`/proc/${pid}/stat`, "utf8"); } catch { continue; }
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    const list = children.get(ppid) ?? [];
    list.push(pid);
    children.set(ppid, list);
  }
  const out: number[] = [];
  const stack = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop();
    if (pid === undefined || seen.has(pid) || pid === process.pid || pid < 2) continue;
    seen.add(pid);
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
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

/** Stops this server and the children it spawned, each by exact PID. */
function stopServer(server: Running | null) {
  if (!server || server.pid === process.pid || server.pid < 2) return;
  const listeners = listeningPids(server.port).filter((pid) => pid !== process.pid && isInGroup(server.pid, pid));
  const targets = [...new Set([...descendantPids(server.pid), ...listeners, server.pid])].filter((pid) => pid > 1 && pid !== process.pid);
  for (const pid of targets) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  spawned.delete(server.pid);
}

/** Child writes one non-secret line, then starts next. The line never includes env values. */
function launcherSource(port: number) {
  const args = JSON.stringify(["next", "start", "-H", "127.0.0.1", "-p", String(port)]);
  return `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const mode = process.env.CRM_VISIBLE;
const label = mode === "all" || mode === "admins" || mode === "off" ? mode : (mode == null || mode === "" ? "unset" : "other");
const tokenMatch = process.env.JOB_SECRET === process.env.SHO_REMINDER_TOKEN_CHECK ? "yes" : "no";
delete process.env.SHO_REMINDER_TOKEN_CHECK;
fs.writeSync(1, "sho-reminder-marker mode=" + label + " token-match=" + tokenMatch + "\\n");
fs.fsyncSync(1);
const child = spawn("npx", ${args}, { cwd: ${JSON.stringify(root)}, env: process.env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code == null ? 1 : code));
child.on("error", () => process.exit(1));
`;
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

/** Starts one mode with its own env. Throws, and stops the process, when that mode cannot start. */
async function startModeServer(mode: Mode): Promise<Running> {
  if (TEST_JOB_SECRET.length < 16) throw new Error("The test-only job token must be at least 16 characters");
  const port = await freePort();
  const outbox = mkdtempSync(path.join(tmpdir(), `sho-remind-${mode}-`));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    EMAIL_OUTBOX_DIR: outbox,
    APP_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
    SUPER_ADMIN_EMAILS: "root.test@aplyd.com",
    JOB_SECRET: TEST_JOB_SECRET,
    SHO_REMINDER_TOKEN_CHECK: TEST_JOB_SECRET,
  };
  delete env.CRM_VISIBLE;
  if (mode !== "unset") env.CRM_VISIBLE = mode;
  const logFd = openSync(path.join(outbox, "server.log"), "a");
  const child = spawn("node", ["-e", launcherSource(port)], {
    cwd: root, env, detached: true, stdio: ["ignore", logFd, logFd],
  });
  closeSync(logFd);
  child.unref();
  if (!child.pid) throw new Error(`CRM_VISIBLE=${mode} cannot start`);
  spawned.add(child.pid);
  const server: Running = { mode, port, pid: child.pid, outbox, base: `http://127.0.0.1:${port}` };
  try {
    await waitForHealth(port, child, 90_000);
  } catch (err) {
    stopServer(server);
    const logPath = path.join(outbox, "server.log");
    const log = existsSync(logPath) ? scrub(readFileSync(logPath, "utf8")).slice(-1500) : "";
    const message = err instanceof Error ? err.message : `CRM_VISIBLE=${mode} cannot start`;
    throw new Error(`${message}${log ? `\n${log}` : ""}`);
  }
  return server;
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

function expectStatus(result: { status: number; text: string }, wanted: number, label: string) {
  expect(result.status, `${label}: ${scrub(result.text).slice(0, 180)}`).toBe(wanted);
}

function verifyToken(outbox: string, email: string) {
  const files = readdirSync(outbox).filter((f) => f.endsWith(".json")).sort();
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(outbox, f), "utf8")) as { to?: string; subject?: string; text?: string });
  const mine = mails.filter((m) => m.to === email && /Verify/.test(m.subject ?? ""));
  return mine.at(-1)?.text?.match(/token=([\w-]+)/)?.[1] ?? null;
}

async function signIn(server: Running, name: string, email: string): Promise<Who> {
  const created = await call(server.base, "", "POST", "/api/auth/signup", { name, email, password: PW });
  if (created.status === 201) {
    const token = verifyToken(server.outbox, email);
    expect(token, `verification mail for ${email}`).toBeTruthy();
    expectStatus(await call(server.base, "", "POST", "/api/auth/verify", { token }), 200, "verify");
  } else {
    expectStatus(created, 409, "signup");
  }
  const signed = await call(server.base, "", "POST", "/api/auth/signin", { email, password: PW });
  expectStatus(signed, 200, "signin");
  const user = signed.json?.user as { id: string } | undefined;
  expect(user?.id).toBeTruthy();
  expect(signed.cookie).toContain("sho_session=");
  return { id: user!.id, cookie: signed.cookie };
}

async function seed(server: Running) {
  const memberEmail = `zzmember.${tag}@aplyd.com`.toLowerCase();
  const adminEmail = `zzdealadmin.${tag}@aplyd.com`.toLowerCase();
  dealAdmin = await signIn(server, `zzdealadmin ${tag}`, adminEmail);
  member = await signIn(server, `zzmember ${tag}`, memberEmail);
  await db.user.update({ where: { id: dealAdmin.id }, data: { orgRole: "ADMIN" } });

  const pipes = await call(server.base, dealAdmin.cookie, "GET", "/api/deals/pipelines");
  expectStatus(pipes, 200, "pipelines");
  const pipe = (pipes.json?.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
  expect(pipe?.id).toBeTruthy();
  const org = await call(server.base, dealAdmin.cookie, "POST", "/api/orgs", { name: `ZZ-TEST Org ${tag}` });
  expectStatus(org, 201, "org");
  const made = await call(server.base, dealAdmin.cookie, "POST", "/api/deals", {
    name: dealName,
    organisationId: (org.json?.organisation as { id: string }).id,
    pipelineId: pipe!.id,
    leaderId: dealAdmin.id,
    whyPursue: "ZZ-TEST fit",
    nextStep: { title: `ZZ-TEST later step ${tag}`, dueDate: istDate(14) },
  });
  expectStatus(made, 201, "deal");
  dealId = (made.json?.deal as { id: string }).id;
  expect(dealId).toBeTruthy();
  expectStatus(await call(server.base, dealAdmin.cookie, "POST", `/api/projects/${dealId}/members`, { userId: member.id, role: "EDITOR" }), 201, "member");

  const memberTask = await call(server.base, dealAdmin.cookie, "POST", `/api/projects/${dealId}/tasks`, {
    title: memberTitle, assigneeId: member.id, dueDate: istDate(1),
  });
  expectStatus(memberTask, 201, "member task");
  memberTaskId = (memberTask.json?.task as { id: string }).id;
  const adminTask = await call(server.base, dealAdmin.cookie, "POST", `/api/projects/${dealId}/tasks`, {
    title: adminTitle, assigneeId: dealAdmin.id, dueDate: istDate(1),
  });
  expectStatus(adminTask, 201, "admin task");
  adminTaskId = (adminTask.json?.task as { id: string }).id;

  const ops = await call(server.base, dealAdmin.cookie, "POST", "/api/projects", { name: `ZZ-TEST Ops ${tag}`, leaderId: dealAdmin.id });
  expectStatus(ops, 201, "ops project");
  opsProjectId = (ops.json?.project as { id: string }).id;
  expectStatus(await call(server.base, dealAdmin.cookie, "POST", `/api/projects/${opsProjectId}/members`, { userId: member.id, role: "EDITOR" }), 201, "ops member");
  const opsTask = await call(server.base, dealAdmin.cookie, "POST", `/api/projects/${opsProjectId}/tasks`, {
    title: opsTitle, assigneeId: member.id, dueDate: istDate(1),
  });
  expectStatus(opsTask, 201, "ops task");
  opsTaskId = (opsTask.json?.task as { id: string }).id;
}

async function clearReminders() {
  await db.notification.deleteMany({ where: { recipientId: { in: [member.id, dealAdmin.id] } } });
}

async function dueRows(recipientId: string) {
  return db.notification.findMany({
    where: { recipientId, type: { in: [...DUE] } },
    select: { recipientId: true, type: true, taskId: true, projectId: true, data: true },
  });
}

async function bell(base: string, who: Who) {
  const result = await call(base, who.cookie, "GET", "/api/notifications?limit=200");
  expectStatus(result, 200, "bell");
  return (result.json?.items ?? []) as { text: string; href: string | null }[];
}

async function expectNoDealReminder(base: string, who: Who) {
  const rows = await dueRows(who.id);
  const leaked = rows.filter((row) => {
    const blob = JSON.stringify(row);
    return row.taskId === memberTaskId || row.taskId === adminTaskId || row.projectId === dealId
      || blob.includes(dealName) || blob.includes(memberTitle) || blob.includes(adminTitle);
  });
  expect(leaked, "hidden deal reminder rows").toEqual([]);
  const body = JSON.stringify(await bell(base, who));
  for (const needle of [dealName, memberTitle, adminTitle, dealId, `/projects/${dealId}`, `/tasks/${memberTaskId}`, `/tasks/${adminTaskId}`]) {
    expect(body, needle).not.toContain(needle);
  }
}

async function expectDealReminder(base: string, who: Who, taskId: string, title: string, exact: boolean) {
  const rows = (await dueRows(who.id)).filter((row) => row.taskId === taskId);
  expect(rows.length).toBeGreaterThanOrEqual(1);
  if (exact) expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ recipientId: who.id, type: "TASK_DUE_TOMORROW", taskId, projectId: dealId, data: { title } });
  const items = (await bell(base, who)).filter((item) => item.href === `/tasks/${taskId}`);
  expect(items.length).toBeGreaterThanOrEqual(1);
  if (exact) expect(items).toHaveLength(1);
  expect(items[0]?.text).toBe(`"${title}" is due tomorrow.`);
}

async function expectOpsReminder(base: string, exact: boolean) {
  const rows = (await dueRows(member.id)).filter((row) => row.taskId === opsTaskId);
  expect(rows.length).toBeGreaterThanOrEqual(1);
  if (exact) expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({
    recipientId: member.id, type: "TASK_DUE_TOMORROW", taskId: opsTaskId, projectId: opsProjectId, data: { title: opsTitle },
  });
  const items = (await bell(base, member)).filter((item) => item.text === `"${opsTitle}" is due tomorrow.` && item.href === `/tasks/${opsTaskId}`);
  expect(items.length).toBeGreaterThanOrEqual(1);
  if (exact) expect(items).toHaveLength(1);
}

/** The listener was started with this mode. A later change in this process does not rewrite that line. */
function expectOwnProcess(server: Running) {
  expect(server.pid).not.toBe(process.pid);
  const listeners = listeningPids(server.port).filter((pid) => isInGroup(server.pid, pid));
  expect(listeners.length, `${server.mode} is listening`).toBeGreaterThan(0);
  const previous = process.env.CRM_VISIBLE;
  process.env.CRM_VISIBLE = server.mode === "off" ? "all" : "off";
  try {
    const log = readFileSync(path.join(server.outbox, "server.log"), "utf8");
    const line = log.split("\n").find((row) => row.startsWith("sho-reminder-marker "));
    const want = `sho-reminder-marker mode=${server.mode} token-match=yes`;
    expect(line).toBe(want);
    expect(line).not.toBe(`sho-reminder-marker mode=${process.env.CRM_VISIBLE} token-match=yes`);
  } finally {
    if (previous === undefined) delete process.env.CRM_VISIBLE;
    else process.env.CRM_VISIBLE = previous;
  }
}

async function postReminders(base: string, count: number) {
  const responses = await Promise.all(Array.from({ length: count }, () => fetch(`${base}/api/jobs/reminders`, {
    method: "POST",
    headers: { authorization: `Bearer ${TEST_JOB_SECRET}` },
  })));
  expect(responses).toHaveLength(count);
  for (const res of responses) {
    const text = await res.text();
    expect(text.includes(TEST_JOB_SECRET)).toBe(false);
    expect(res.status, scrub(text).slice(0, 180)).toBe(200);
    let body: { status?: string; result?: { sent?: number } };
    try {
      body = JSON.parse(text) as { status?: string; result?: { sent?: number } };
    } catch {
      throw new Error(`Job response was not JSON (status ${res.status}): ${scrub(text).slice(0, 180)}`);
    }
    expect(body.status).toBe("OK");
    expect(typeof body.result?.sent).toBe("number");
  }
}

async function runMode(mode: Mode) {
  const server = await startModeServer(mode);
  try {
    expectOwnProcess(server);
    await clearReminders();
    await postReminders(server.base, 1);
    if (mode === "unset" || mode === "all") {
      await expectDealReminder(server.base, member, memberTaskId, memberTitle, true);
      await expectDealReminder(server.base, dealAdmin, adminTaskId, adminTitle, true);
    } else if (mode === "admins") {
      await expectNoDealReminder(server.base, member);
      await expectDealReminder(server.base, dealAdmin, adminTaskId, adminTitle, true);
    } else {
      await expectNoDealReminder(server.base, member);
      await expectNoDealReminder(server.base, dealAdmin);
    }
    await expectOpsReminder(server.base, true);

    await clearReminders();
    await postReminders(server.base, LOAD);
    if (mode === "unset" || mode === "all") {
      await expectDealReminder(server.base, member, memberTaskId, memberTitle, false);
      await expectDealReminder(server.base, dealAdmin, adminTaskId, adminTitle, false);
    } else if (mode === "admins") {
      await expectNoDealReminder(server.base, member);
      await expectDealReminder(server.base, dealAdmin, adminTaskId, adminTitle, false);
    } else {
      await expectNoDealReminder(server.base, member);
      await expectNoDealReminder(server.base, dealAdmin);
    }
    await expectOpsReminder(server.base, false);
  } finally {
    stopServer(server);
  }
}

describe("qa:TC missing APL-2729 AC4: reminder jobs run on one server process per CRM_VISIBLE mode", () => {
  beforeAll(async () => {
    assertLocalTestDatabase();
    if (!existsSync(path.join(root, ".next", "BUILD_ID"))) {
      throw new Error("CRM_VISIBLE mode cannot start: the production build is missing (.next/BUILD_ID)");
    }
    // descendantPids / listeningPids / isInGroup and stopServer read Linux procfs only.
    assertProcfs();
    const server = await startModeServer("unset");
    try {
      await seed(server);
    } finally {
      stopServer(server);
    }
  }, 180_000);

  afterAll(async () => {
    for (const pid of [...spawned]) {
      const targets = [...descendantPids(pid), pid].filter((target) => target > 1 && target !== process.pid);
      for (const target of targets) {
        try { process.kill(target, "SIGKILL"); } catch { /* already gone */ }
      }
      spawned.delete(pid);
    }
    if (member?.id) {
      await db.notification.deleteMany({ where: { recipientId: { in: [member.id, dealAdmin.id] } } });
    }
    await db.$disconnect();
  });

  it("qa:TC missing AC2 AC3 AC4: unset server matches main for member, admin and the ops check, including 40 concurrent job posts", async () => {
    await runMode("unset");
  });

  it("qa:TC missing AC2 AC3 AC4: CRM_VISIBLE=all server matches main for member, admin and the ops check, including 40 concurrent job posts", async () => {
    await runMode("all");
  });

  it("qa:TC missing AC1 AC2 AC3 AC4: admins server gives a member no deal reminder, an admin the reminder as on main, and the ops check unchanged", async () => {
    await runMode("admins");
  });

  it("qa:TC missing AC1 AC3 AC4: off server gives nobody a deal reminder and leaves the ops check unchanged", async () => {
    await runMode("off");
  });
});
