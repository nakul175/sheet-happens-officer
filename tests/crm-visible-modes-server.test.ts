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
import { HIDDEN_DEAL_TEXT } from "../src/lib/feed";
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
const seed: { userIds: string[]; emails: string[]; projectId?: string; plainProjectId?: string; orgId?: string } = { userIds: [], emails: [] };

/** Removes this run's users, deal and organisation so the shared test database stays clear. */
async function cleanupSeed() {
  const users = seed.emails.length || seed.userIds.length
    ? await db.user.findMany({
      where: { OR: [{ id: { in: seed.userIds } }, { email: { in: seed.emails } }] },
      select: { id: true },
    })
    : [];
  const userIds = users.map((user) => user.id);
  if (userIds.length) {
    await db.modelUsage.deleteMany({ where: { userId: { in: userIds } } });
    await db.actionLog.deleteMany({
      where: { OR: [{ actorId: { in: userIds } }, ...(seed.projectId ? [{ projectId: seed.projectId }] : [])] },
    });
    await db.auditLog.deleteMany({ where: { actorId: { in: userIds } } });
  } else if (seed.projectId) {
    await db.actionLog.deleteMany({ where: { projectId: seed.projectId } });
  }
  if (seed.projectId) await db.project.deleteMany({ where: { id: seed.projectId } });
  if (seed.plainProjectId) await db.project.deleteMany({ where: { id: seed.plainProjectId } });
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

/** Notification sentences from a bell response. Throws when the body is not that list. */
function notificationTexts(body: string): string[] {
  const parsed = JSON.parse(body) as { items?: { text?: unknown }[] };
  if (!Array.isArray(parsed.items)) throw new Error("bell response has no notification list");
  return parsed.items.map((item) => (typeof item.text === "string" ? item.text : ""));
}

function bellItems(body: string): { unread: number; items: { text: string; href: string | null }[] } {
  const parsed = JSON.parse(body) as { unread?: unknown; items?: { text?: unknown; href?: unknown }[] };
  if (!Array.isArray(parsed.items) || typeof parsed.unread !== "number") throw new Error("bell response has no notification list");
  return {
    unread: parsed.unread,
    items: parsed.items.map((item) => ({
      text: typeof item.text === "string" ? item.text : "",
      href: typeof item.href === "string" ? item.href : null,
    })),
  };
}

/**
 * APL-2698. The bell row is mustName=false: other reads may omit the deal name, but notification
 * text includes it only when this person may see the deal, and the check fails when a hidden name is present.
 */
function assertBellDealName(body: string, dealName: string, visible: boolean, label = "mustName=false") {
  const present = notificationTexts(body).some((text) => text.includes(dealName));
  if (visible) expect(present, `${label} notification text names the deal`).toBe(true);
  else expect(present, `${label} notification text leaked the deal name`).toBe(false);
}

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

function environ(pid: number) {
  const raw = readFileSync(`/proc/${pid}/environ`);
  const out: Record<string, string> = {};
  for (const entry of raw.toString("utf8").split("\0")) {
    const i = entry.indexOf("=");
    if (i > 0) out[entry.slice(0, i)] = entry.slice(i + 1);
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

describe("bell mustName=false check (APL-2698 AC2)", () => {
  // qa:TC-APL2698-53c26943@v1 · AC2. A hidden bell response that includes the deal name fails the check.
  it("qa:TC-APL2698-53c26943@v1 fails when a hidden bell response includes the deal name", () => {
    const name = "Acme renewal ZZ-TEST-local";
    const body = JSON.stringify({ items: [{ text: `Someone moved "${name}" to Proposal.` }] });
    expect(() => assertBellDealName(body, name, false)).toThrow(/leaked the deal name/);
  });
});

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
    await db.projectMember.create({ data: { projectId: dealId, userId: admin.id, role: "EDITOR" } });
    await db.taskCollaborator.create({ data: { taskId: task!.id, userId: admin.id } });
    // Bell rows store the deal name, a deal task title and the deal id. APL-2698 checks the
    // name. APL-2716 checks that a hidden reader gets one generic sentence and no deal link.
    const outsiderEmail = `outsider.${tag}@aplyd.com`.toLowerCase();
    seed.emails.push(outsiderEmail);
    const outsider = await signIn(open!, `outsider ${tag}`, outsiderEmail);
    seed.userIds.push(outsider.id);
    const taskTitle = `ZZ-TEST Acme kickoff ${runId}`;
    const kickoffTaskId = `kickoff-${tag}`;
    const plainTitle = `Pack the cartons ${tag}`;
    const plainTaskId = `plain-${tag}`;
    const dealRow = await db.project.findUnique({ where: { id: dealId }, select: { workspaceId: true } });
    expect(dealRow?.workspaceId).toBeTruthy();
    const plain = await db.project.create({ data: { workspaceId: dealRow!.workspaceId, name: `Packing ${tag}`, typeId: "wst_project" } });
    seed.plainProjectId = plain.id;
    const hiddenText = HIDDEN_DEAL_TEXT;
    const stageText = `Someone moved "${dealName}" to Proposal.`;
    const nextStepText = `"${dealName}" needs a next step.`;
    const stalledText = `"${dealName}" has had no activity for 30 days.`;
    const taskText = `Someone assigned you "${taskTitle}".`;
    const plainText = `Someone assigned you "${plainTitle}".`;
    await db.notification.createMany({
      data: [member.id, admin.id, outsider.id].flatMap((recipientId) => [
        { recipientId, type: "DEAL_STAGE_CHANGED", projectId: dealId, data: { project: dealName, stage: "Proposal" } },
        { recipientId, type: "DEAL_NEEDS_NEXT_STEP", projectId: dealId, data: { project: dealName } },
        { recipientId, type: "DEAL_STALLED", projectId: dealId, data: { project: dealName } },
        { recipientId, type: "TASK_ASSIGNED", projectId: dealId, taskId: kickoffTaskId, data: { title: taskTitle, project: dealName } },
        { recipientId, type: "TASK_ASSIGNED", projectId: plain.id, taskId: plainTaskId, data: { title: plainTitle, project: `Packing ${tag}` } },
      ]),
    });

    const people = { member, admin };
    // Pam's AC1 cases. `on` is covered below as the everyone mode (crmMode reads it as all).
    const examples: { mode: Mode; user: "member" | "admin"; visible: boolean; tc?: string }[] = [
      { mode: "on", user: "member", visible: true },
      { mode: "admins", user: "member", visible: false, tc: "qa:TC-APL2698-9a92c751@v1" },
      { mode: "admins", user: "admin", visible: true },
      { mode: "off", user: "admin", visible: false, tc: "qa:TC-APL2698-448f7d2f@v1" },
    ];
    for (const example of examples) {
      const server = running.get(example.mode)!;
      const who = people[example.user];
      const label = `${example.tc ? example.tc + " " : ""}mode=${example.mode} user=${example.user} visible=${example.visible ? "yes" : "no"}`;
      const reads = await readPaths(server.base, who.cookie, dealId, dealName);
      for (const read of reads) {
        const wanted = example.visible ? 200 : read.hiddenStatus;
        expect(read.status, `${label} ${read.name}`).toBe(wanted);
        if (!read.mustName) assertBellDealName(read.text, dealName, example.visible, label);
        else if (example.visible) expect(read.text, `${label} ${read.name}`).toContain(dealName);
        else expect(read.text, `${label} ${read.name}`).not.toContain(dealName);
      }
      const joined = reads.map((read) => read.text).join("\n");
      if (example.visible) expect(joined, label).toContain(dealName);
      else expect(joined, label).not.toContain(dealName);
    }

    // APL-2698 AC3. The open server is CRM_VISIBLE=on; crmMode() treats that as all.
    const bellOnly: { mode: Mode; who: { cookie: string }; user: string; visible: boolean; modeLabel: string; tc: string }[] = [
      { mode: "on", who: admin, user: "admin", visible: true, modeLabel: "all", tc: "qa:TC-APL2698-513157e4@v1" },
      { mode: "off", who: member, user: "member", visible: false, modeLabel: "off", tc: "qa:TC-APL2698-2c0a1372@v1" },
      { mode: "on", who: outsider, user: "member with no access to the deal", visible: false, modeLabel: "all", tc: "qa:TC-APL2698-be2ba3d5@v1" },
    ];
    for (const row of bellOnly) {
      const server = running.get(row.mode)!;
      const bell = await call(server.base, row.who.cookie, "GET", "/api/notifications");
      const label = `${row.tc} mode=${row.modeLabel} user=${row.user} visible=${row.visible ? "yes" : "no"}`;
      expect(bell.status, label).toBe(200);
      assertBellDealName(bell.text, dealName, row.visible, label);
    }

    // APL-2716. Admin and the on-deal member across all, admins and off.
    // A reader who cannot see the deal gets the generic sentence. A non-deal notice stays as stored.
    const dealHref = `/projects/${dealId}`;
    const taskHref = `/tasks/${kickoffTaskId}`;
    const plainHref = `/tasks/${plainTaskId}`;
    const controls: { mode: Mode; who: { cookie: string }; user: string; sees: boolean; tc: string }[] = [
      { mode: "on", who: admin, user: "admin", sees: true, tc: "qa:TC-APL2716-a8042ed1@v1" },
      { mode: "admins", who: admin, user: "admin", sees: true, tc: "qa:TC-APL2716-3abdb652@v1" },
      { mode: "off", who: admin, user: "admin", sees: false, tc: "qa:TC-APL2716-d2ec503b@v1" },
      { mode: "on", who: member, user: "on-deal member", sees: true, tc: "qa:TC-APL2716-a8042ed1@v1" },
      { mode: "admins", who: member, user: "member", sees: false, tc: "qa:TC-APL2716-3abdb652@v1" },
      { mode: "off", who: member, user: "on-deal member", sees: false, tc: "qa:TC-APL2716-d2ec503b@v1" },
      { mode: "on", who: outsider, user: "member with no access", sees: false, tc: "qa:TC-APL2698-be2ba3d5@v1" },
      { mode: "admins", who: outsider, user: "member with no access", sees: false, tc: "qa:TC-APL2716-85782555@v1" },
      { mode: "off", who: outsider, user: "member with no access", sees: false, tc: "qa:TC-APL2716-fcc1861b@v1" },
    ];
    for (const row of controls) {
      const server = running.get(row.mode)!;
      const modeLabel = row.mode === "on" ? "all" : row.mode;
      const bell = await call(server.base, row.who.cookie, "GET", "/api/notifications");
      const label = `${row.tc} mode=${modeLabel} user=${row.user} sees=${row.sees ? "yes" : "no"}`;
      expect(bell.status, label).toBe(200);
      const page = bellItems(bell.text);
      expect(page.items, label).toHaveLength(5);
      expect(page.unread, `${label} unread count`).toBe(5);
      expect(page.items, `qa:TC-APL2716-4811612d@v1 ${label}`).toContainEqual({ text: plainText, href: plainHref });
      if (row.sees) {
        expect(page.items, `qa:TC-APL2716-3abdb652@v1 ${label} deal name`).toContainEqual({ text: stageText, href: dealHref });
        expect(page.items, `qa:TC-APL2716-85782555@v1 ${label}`).toContainEqual({ text: nextStepText, href: dealHref });
        expect(page.items, `qa:TC-APL2716-fcc1861b@v1 ${label}`).toContainEqual({ text: stalledText, href: dealHref });
        expect(page.items, `${label} task title`).toContainEqual({ text: taskText, href: taskHref });
      } else {
        const hidden = page.items.filter((item) => item.text !== plainText);
        expect(hidden, label).toHaveLength(4);
        for (const item of hidden) {
          expect(item.text, `qa:TC-APL2716-3abdb652@v1 ${label}`).toBe(hiddenText);
          expect(item.href, `${label} href`).toBeNull();
        }
        expect(bell.text, `${label} deal name`).not.toContain(dealName);
        expect(bell.text, `${label} task title`).not.toContain(taskTitle);
        expect(bell.text, `${label} stage`).not.toContain("Proposal");
        expect(bell.text, `${label} deal href`).not.toContain(dealHref);
        expect(bell.text, `${label} task href`).not.toContain(taskHref);
        expect(bell.text, `qa:TC-APL2716-85782555@v1 ${label}`).not.toContain("needs a next step");
        expect(bell.text, `qa:TC-APL2716-fcc1861b@v1 ${label}`).not.toContain("no activity");
      }
    }
  }, 120_000);

  it("Each mode runs in its own server process", async () => {
    expect([...running.keys()].sort()).toEqual([...MODES].sort());
    const pids = [...running.values()].map((server) => server.pid);
    expect(new Set(pids).size, "each mode has its own process").toBe(MODES.length);
    expect(pids.every((pid) => pid !== process.pid)).toBe(true);
    const envs = [...running.values()].map((server) => server.env);
    expect(new Set(envs).size, "each mode has its own env object").toBe(MODES.length);

    const listeners: number[] = [];
    for (const server of running.values()) {
      expect(server.env.CRM_VISIBLE).toBe(server.mode);
      const health = await fetch(`${server.base}/api/health`);
      expect(health.status, server.mode).toBe(200);
      const listening = listeningPids(server.port);
      expect(listening.length, `${server.mode} is listening`).toBeGreaterThan(0);
      for (const pid of listening) {
        expect(isInGroup(server.pid, pid), `${server.mode} listener ${pid} belongs to ${server.pid}`).toBe(true);
        expect(environ(pid).CRM_VISIBLE, server.mode).toBe(server.mode);
        expect(environ(pid).EMAIL_OUTBOX_DIR).toBe(server.outbox);
        expect(environ(pid).APP_URL).toBe(server.base);
      }
      listeners.push(...listening);
    }
    expect(new Set(listeners).size, "no mode reuses another mode's process").toBe(listeners.length);
    const modes = new Set([...running.values()].map((server) => environ(listeningPids(server.port)[0]).CRM_VISIBLE));
    expect(modes).toEqual(new Set(MODES));

    await expect(startModeServer("on", { bin: process.execPath, args: ["-e", "process.exit(1)"], timeoutMs: 3_000 })).rejects.toThrow(/cannot start/);
    await expect(startModeServer("off", { bin: process.execPath, args: ["-e", "setInterval(() => {}, 1e9)"], timeoutMs: 800 })).rejects.toThrow(/cannot start/);
  }, 30_000);
});
