// APL-2713 AC4. Same shape as tests/crm-visible-modes-server.mode.test.ts: one `next start` per CRM_VISIBLE mode.
// crmMode() treats every value other than `admins` and `off` as everyone, so the open mode is CRM_VISIBLE=on.
// Run with `npm run test:modes` after `npm run build`. `npm test` does not start these servers.
// Fails when a hidden deal, its stage, its task or type DEAL shows up on GET /api/my-tasks.
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { istDate, PW } from "./helpers";

const root = fileURLToPath(new URL("..", import.meta.url));
const runId = `${Date.now().toString(36)}-${process.pid}`;
const tag = `ZZ-TEST-${runId}`;
const DEAL_NAME = "ZZ-TEST Acme renewal";
const KICKOFF = "ZZ-TEST Acme kickoff";
const CONTRACT = "ZZ-TEST Acme contract";
const PLAIN = "ZZ-TEST plain handoff";
const STAGE = "Proposal";
const MODES = ["on", "admins", "off"] as const;
type Mode = (typeof MODES)[number];

type Running = { mode: Mode; port: number; pid: number; outbox: string; env: NodeJS.ProcessEnv; base: string };
type ApiTask = { id: string; title: string; project: { id: string; name: string; type: string; stage: string | null }; assignee?: { id: string } };
type ApiGroups = {
  waitingOnMe: ApiTask[];
  waitingOnOthers: ApiTask[];
  overdue: ApiTask[];
  next7: ApiTask[];
  later: ApiTask[];
  needsNextStep?: { id: string; name: string; stage: string | null }[];
};

const running = new Map<Mode, Running>();
/** Every outbox startModeServer made. afterAll removes them whether the test passes or fails (APL-2890). */
const outboxes = new Set<string>();
const signed: { editor?: string; admin?: string } = {};
const LOAD = 40;
const seed: { userIds: string[]; emails: string[]; projectIds: string[]; orgId?: string; dealId?: string; kickoffId?: string; contractId?: string; plainId?: string } = {
  userIds: [], emails: [], projectIds: [],
};

const GROUP_KEYS = ["waitingOnMe", "waitingOnOthers", "overdue", "next7", "later"] as const;
const HIDDEN_WORDS = [DEAL_NAME, STAGE, KICKOFF, CONTRACT];

async function cleanupSeed() {
  const users = seed.emails.length || seed.userIds.length
    ? await db.user.findMany({ where: { OR: [{ id: { in: seed.userIds } }, { email: { in: seed.emails } }] }, select: { id: true } })
    : [];
  const userIds = users.map((user) => user.id);
  if (userIds.length || seed.projectIds.length) {
    await db.actionLog.deleteMany({
      where: { OR: [...(userIds.length ? [{ actorId: { in: userIds } }] : []), ...(seed.projectIds.length ? [{ projectId: { in: seed.projectIds } }] : [])] },
    });
  }
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
  const outbox = mkdtempSync(path.join(tmpdir(), `sho-apl2713-${mode}-`));
  outboxes.add(outbox);
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
  // Signup stores the address in lowercase (schemas.ts). Match the outbox the same way.
  const want = email.toLowerCase();
  const files = readdirSync(outbox).filter((f) => f.endsWith(".json")).sort();
  const mails = files.map((f) => JSON.parse(readFileSync(path.join(outbox, f), "utf8")) as { to?: string; subject?: string; text?: string });
  const mine = mails.filter((m) => (m.to ?? "").toLowerCase() === want && /Verify/.test(m.subject ?? ""));
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
  return { id: user!.id, cookie: signed.cookie, name };
}

async function myTasks(server: Running, cookie: string) {
  const res = await call(server.base, cookie, "GET", "/api/my-tasks");
  expect(res.status, res.text).toBe(200);
  return { text: res.text, body: res.json as unknown as ApiGroups };
}

function assertHidden(label: string, text: string, body: ApiGroups) {
  for (const word of HIDDEN_WORDS) expect(text, `${label} contains ${word}`).not.toContain(word);
  expect(text, `${label} type DEAL`).not.toContain('"DEAL"');
  for (const key of GROUP_KEYS) {
    expect(body[key].some((t) => t.project.type === "DEAL" || t.project.id === seed.dealId || t.id === seed.kickoffId || t.id === seed.contractId), `${label} ${key}`).toBe(false);
  }
  expect(body.waitingOnOthers.some((t) => t.project.id === seed.dealId), `${label} waitingOnOthers`).toBe(false);
  expect((body.needsNextStep ?? []).some((d) => d.name === DEAL_NAME || d.stage === STAGE || d.id === seed.dealId), `${label} needsNextStep`).toBe(false);
}

function handed(body: ApiGroups, id: string) {
  return body.waitingOnOthers.find((t) => t.id === id);
}

describe("qa:TC missing CRM_VISIBLE modes hide handed-off deal tasks on a real server per mode", () => {
  beforeAll(async () => {
    if (!existsSync(path.join(root, ".next", "BUILD_ID"))) {
      throw new Error("CRM_VISIBLE mode cannot start: the production build is missing (.next/BUILD_ID)");
    }
    await db.$connect();
    await Promise.all(MODES.map(async (mode) => {
      const server = await startModeServer(mode);
      running.set(server.mode, server);
    }));
  }, 180_000);

  afterAll(async () => {
    try { await cleanupSeed(); } finally {
      for (const server of running.values()) killGroup(server.pid);
      for (const dir of outboxes) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  // qa:TC missing · covers AC1 and AC2. A hidden deal in any group fails this test.
  it("qa:TC missing hides handed-off deal tasks per CRM mode and shows them when visible", async () => {
    const open = running.get("on");
    const admins = running.get("admins");
    const off = running.get("off");
    expect(open && admins && off, "each mode server is running").toBeTruthy();

    const editorEmail = `editor.${tag}@aplyd.com`.toLowerCase();
    const approverEmail = `approver.${tag}@aplyd.com`.toLowerCase();
    const adminEmail = `admin.${tag}@aplyd.com`.toLowerCase();
    seed.emails.push(editorEmail, approverEmail, adminEmail);
    const editor = await signIn(open!, "editor", editorEmail);
    const approver = await signIn(open!, "approver", approverEmail);
    const adminUser = await signIn(open!, "admin", adminEmail);
    signed.editor = editor.cookie;
    signed.admin = adminUser.cookie;
    seed.userIds.push(editor.id, approver.id, adminUser.id);
    await db.user.update({ where: { id: adminUser.id }, data: { orgRole: "ADMIN" } });

    const pipes = await call(open!.base, editor.cookie, "GET", "/api/deals/pipelines");
    expect(pipes.status, pipes.text).toBe(200);
    const pipelines = pipes.json?.pipelines as { id: string; key: string; stages: { id: string; name: string }[] }[];
    const pipe = pipelines.find((p) => p.key === "DEAL_PROACTIVE");
    const proposal = pipe?.stages.find((s) => s.name === STAGE);
    expect(proposal?.id).toBeTruthy();
    const org = await call(open!.base, editor.cookie, "POST", "/api/orgs", { name: `Buyer ${tag}` });
    expect(org.status, org.text).toBe(201);
    seed.orgId = (org.json?.organisation as { id: string }).id;
    const made = await call(open!.base, editor.cookie, "POST", "/api/deals", {
      name: DEAL_NAME, organisationId: seed.orgId, pipelineId: pipe!.id, leaderId: approver.id, whyPursue: tag,
      nextStep: { title: "Call the buyer", dueDate: istDate(3) },
    });
    expect(made.status, made.text).toBe(201);
    seed.dealId = (made.json?.deal as { id: string }).id;
    seed.projectIds.push(seed.dealId);
    expect((await call(open!.base, approver.cookie, "POST", `/api/projects/${seed.dealId}/members`, { userId: adminUser.id, role: "EDITOR" })).status).toBe(201);
    expect((await call(open!.base, editor.cookie, "POST", `/api/projects/${seed.dealId}/stage`, { stageId: proposal!.id })).status).toBe(200);

    const kickoff = await call(open!.base, approver.cookie, "POST", `/api/projects/${seed.dealId}/tasks`, {
      title: KICKOFF, assigneeId: editor.id, approverId: approver.id, dueDate: istDate(4),
    });
    expect(kickoff.status, kickoff.text).toBe(201);
    seed.kickoffId = (kickoff.json?.task as { id: string }).id;
    expect((await call(open!.base, editor.cookie, "POST", `/api/tasks/${seed.kickoffId}/send-for-approval`)).status).toBe(200);

    const contract = await call(open!.base, approver.cookie, "POST", `/api/projects/${seed.dealId}/tasks`, {
      title: CONTRACT, assigneeId: adminUser.id, approverId: approver.id, dueDate: istDate(5),
    });
    expect(contract.status, contract.text).toBe(201);
    seed.contractId = (contract.json?.task as { id: string }).id;
    expect((await call(open!.base, adminUser.cookie, "POST", `/api/tasks/${seed.contractId}/send-for-approval`)).status).toBe(200);

    const plainProject = await call(open!.base, editor.cookie, "POST", "/api/projects", { name: `Workshop ${tag}`, leaderId: approver.id });
    expect(plainProject.status, plainProject.text).toBe(201);
    const plainProjectId = (plainProject.json?.project as { id: string }).id;
    seed.projectIds.push(plainProjectId);
    const plain = await call(open!.base, approver.cookie, "POST", `/api/projects/${plainProjectId}/tasks`, {
      title: PLAIN, assigneeId: editor.id, approverId: approver.id, dueDate: istDate(4),
    });
    expect(plain.status, plain.text).toBe(201);
    seed.plainId = (plain.json?.task as { id: string }).id;
    expect((await call(open!.base, editor.cookie, "POST", `/api/tasks/${seed.plainId}/send-for-approval`)).status).toBe(200);

    const hidden: { mode: Mode; who: "editor" | "admin"; cookie: string }[] = [
      { mode: "off", who: "editor", cookie: editor.cookie },
      { mode: "off", who: "admin", cookie: adminUser.cookie },
      { mode: "admins", who: "editor", cookie: editor.cookie },
    ];
    for (const example of hidden) {
      const server = running.get(example.mode)!;
      const got = await myTasks(server, example.cookie);
      const label = `mode=${example.mode} user=${example.who}`;
      assertHidden(label, got.text, got.body);
      if (example.who === "editor") {
        expect(handed(got.body, seed.plainId!)?.title, label).toBe(PLAIN);
        expect(handed(got.body, seed.plainId!)?.project.type, label).toBe("PROJECT");
      }
    }

    const editorOn = await myTasks(open!, editor.cookie);
    const kick = handed(editorOn.body, seed.kickoffId!);
    expect(kick?.title).toBe(KICKOFF);
    expect(kick?.project).toEqual({ id: seed.dealId, name: DEAL_NAME, type: "DEAL", stage: STAGE });
    expect(GROUP_KEYS.filter((key) => key !== "waitingOnOthers").some((key) => editorOn.body[key].some((t) => t.id === seed.kickoffId))).toBe(false);

    const adminOn = await myTasks(open!, adminUser.cookie);
    const adminAdmins = await myTasks(admins!, adminUser.cookie);
    const contractOn = handed(adminOn.body, seed.contractId!);
    const contractAdmins = handed(adminAdmins.body, seed.contractId!);
    expect(contractOn?.title).toBe(CONTRACT);
    expect(contractOn?.project).toEqual({ id: seed.dealId, name: DEAL_NAME, type: "DEAL", stage: STAGE });
    expect(contractAdmins).toEqual(contractOn);

    for (const server of [open!, admins!, off!]) {
      const got = await myTasks(server, editor.cookie);
      expect(handed(got.body, seed.plainId!)?.title, server.mode).toBe(PLAIN);
    }
  }, 120_000);

  // The handed-off query is on the My tasks read path. 40 concurrent GETs in each hidden case.
  it("qa:TC missing load: 40 concurrent GET /api/my-tasks in each hidden mode", async () => {
    expect(signed.editor && signed.admin, "AC4 signed in editor and admin").toBeTruthy();
    const hidden: { mode: Mode; who: "editor" | "admin"; cookie: string; plain: boolean }[] = [
      { mode: "off", who: "editor", cookie: signed.editor!, plain: true },
      { mode: "off", who: "admin", cookie: signed.admin!, plain: false },
      { mode: "admins", who: "editor", cookie: signed.editor!, plain: true },
    ];
    for (const example of hidden) {
      const server = running.get(example.mode)!;
      const label = `mode=${example.mode} user=${example.who}`;
      const results = await Promise.all(Array.from({ length: LOAD }, () => call(server.base, example.cookie, "GET", "/api/my-tasks").catch((err: unknown) => ({
        status: 0,
        text: err instanceof Error ? err.message : "request failed",
        json: null,
        cookie: example.cookie,
      }))));
      expect(results, label).toHaveLength(LOAD);
      const failed = results.filter((res) => res.status !== 200);
      expect(failed.map((res) => ({ status: res.status, text: res.text.slice(0, 200) })), label).toEqual([]);
      for (const res of results) {
        const body = res.json as unknown as ApiGroups;
        assertHidden(`${label} load`, res.text, body);
        if (example.plain) expect(res.text, label).toContain(PLAIN);
      }
    }
  }, 120_000);
});
