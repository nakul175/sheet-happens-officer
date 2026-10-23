// APL-2658. Each CRM_VISIBLE mode is its own `next start` process and its own environment.
// Michael's scenario names the open mode `on`. crmMode() treats every value other than `admins` and `off`
// as everyone, so the server for that row is started with CRM_VISIBLE=on.
// Run with `npm run test:crm-modes` after `npm run build`. `npm test` does not start these servers.
// A missing build, or a mode that never answers /api/health, fails this file.
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../src/lib/db";
import { HIDDEN_DEAL_TEXT } from "../src/lib/feed";
import { QUICK_ACTIONS } from "../src/lib/concierge/reads";
import { istDate, PW } from "./helpers";
import { portAnswers } from "./spawned-listener";

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
/** CRM_VISIBLE=all and an unset CRM_VISIBLE. Not part of the three-mode process check. */
const extra = new Map<"all" | "unset", Running>();
/** Every outbox startModeServer made and has not removed. afterAll removes the rest (APL-2891). */
const outboxes = new Set<string>();

function removeOutbox(dir: string) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  outboxes.delete(dir);
}
const seed: {
  userIds: string[]; emails: string[]; projectId?: string; plainProjectId?: string; projectIds: string[]; orgId?: string; orgIds: string[];
} = { userIds: [], emails: [], projectIds: [], orgIds: [] };

/**
 * Through the API, as the Super Admin: takes over as Leader where this run's people lead, archives this run's
 * projects and organisations, then deactivates this run's people (APL-2728: no direct database writes here).
 */
async function cleanupSeed() {
  const server = running.get("on");
  if (!server) return;
  const sa = await superAdminOn(server);
  const problems: string[] = [];
  const projectIds = [...new Set([seed.projectId, seed.plainProjectId, ...seed.projectIds].filter((id): id is string => !!id))];
  const orgIds = [...new Set([...(seed.orgId ? [seed.orgId] : []), ...seed.orgIds])];
  for (const id of projectIds) {
    const got = await call(server.base, sa.cookie, "GET", `/api/projects/${id}`);
    const members = ((got.json?.project as { members?: { userId: string; role: string }[] } | undefined)?.members) ?? [];
    const leader = members.find((m) => m.role === "LEADER");
    if (leader && leader.userId !== sa.id) {
      if (!members.some((m) => m.userId === sa.id)) {
        const added = await call(server.base, sa.cookie, "POST", `/api/projects/${id}/members`, { userId: sa.id, role: "EDITOR" });
        if (added.status !== 201) problems.push(`join ${id}: ${added.status}`);
      }
      const led = await call(server.base, sa.cookie, "POST", `/api/projects/${id}/leader`, { newLeaderId: sa.id, previousRole: "EDITOR" });
      if (led.status !== 200) problems.push(`take over ${id}: ${led.status}`);
    }
    const archived = await call(server.base, sa.cookie, "POST", `/api/projects/${id}/archive`);
    if (archived.status !== 200) problems.push(`archive project ${id}: ${archived.status}`);
  }
  for (const id of orgIds) {
    const archived = await call(server.base, sa.cookie, "POST", `/api/orgs/${id}/archive`, { archive: true });
    if (archived.status !== 200 && archived.status !== 409) problems.push(`archive organisation ${id}: ${archived.status}`);
  }
  for (const id of new Set(seed.userIds)) {
    if (id === sa.id) continue;
    const off = await call(server.base, sa.cookie, "POST", `/api/team/${id}/deactivate`, { reassign: "leaders" });
    if (off.status !== 200 && !(off.status === 409 && /already deactivated/.test(off.text))) problems.push(`deactivate ${id}: ${off.status}`);
  }
  expect(problems).toEqual([]);
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

/**
 * Starts one mode. Throws, and stops the process, when that mode cannot start.
 * `crm` overrides CRM_VISIBLE. `null` removes it, which crmMode() reads as all.
 */
async function startModeServer(mode: Mode, opts: { bin?: string; args?: string[]; timeoutMs?: number; crm?: string | null } = {}): Promise<Running> {
  const port = await freePort();
  const label = opts.crm === null ? "unset" : opts.crm ?? mode;
  const outbox = mkdtempSync(path.join(tmpdir(), `sho-crm-${label}-`));
  outboxes.add(outbox);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    EMAIL_OUTBOX_DIR: outbox,
    APP_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
    SUPER_ADMIN_EMAILS: "root.test@aplyd.com",
    JOB_SECRET: process.env.JOB_SECRET || "replace-with-a-token-of-at-least-16-chars",
  };
  if (opts.crm === null) delete env.CRM_VISIBLE;
  else env.CRM_VISIBLE = opts.crm ?? mode;
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
    removeOutbox(outbox);
    throw new Error(`${message}${log ? `\n${log}` : ""}`);
  }
  if (!child.pid) throw new Error(`CRM_VISIBLE=${mode} cannot start`);
  return { mode, port, pid: child.pid, outbox, env, base: `http://127.0.0.1:${port}` };
}

/** Starts every server. If one rejects, closes the ones that started and removes their outboxes, then throws. */
async function startServers(starts: (() => Promise<Running>)[]): Promise<Running[]> {
  const results = await Promise.allSettled(starts.map((start) => start()));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  const started = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (!failed) return started;
  for (const server of started) {
    killGroup(server.pid);
    removeOutbox(server.outbox);
  }
  throw failed.reason;
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

/** Listed in each mode server's SUPER_ADMIN_EMAILS (startModeServer). */
const SUPER_EMAIL = "root.test@aplyd.com";
let superSession: { id: string; cookie: string } | null = null;

async function superAdminOn(server: Running) {
  superSession ??= await signIn(server, "Root", SUPER_EMAIL);
  return superSession;
}

/** APL-2728: the role change goes through PATCH /api/team/:id as the Super Admin, not a database write. */
async function promoteToAdmin(server: Running, userId: string) {
  const sa = await superAdminOn(server);
  const promoted = await call(server.base, sa.cookie, "PATCH", `/api/team/${userId}`, { orgRole: "ADMIN" });
  expect(promoted.status, promoted.text).toBe(200);
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
    const [on, admins, off, all, unset] = await startServers([
      () => startModeServer("on"),
      () => startModeServer("admins"),
      () => startModeServer("off"),
      () => startModeServer("on", { crm: "all" }),
      () => startModeServer("on", { crm: null }),
    ]);
    running.set("on", on);
    running.set("admins", admins);
    running.set("off", off);
    extra.set("all", all);
    extra.set("unset", unset);
  }, 180_000);

  afterAll(async () => {
    try { await cleanupSeed(); } finally {
      for (const server of [...running.values(), ...extra.values()]) killGroup(server.pid);
      for (const dir of outboxes) removeOutbox(dir);
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
    // ADDED_TO_PROJECT is written with the deal's projectId (projects.ts addMember). The packing
    // project is the non-deal control: its sentence and href stay in every mode.
    const addedDealText = `Someone added you to "${dealName}" as editor.`;
    const addedPlainText = `Someone added you to "Packing ${tag}" as editor.`;
    await db.notification.createMany({
      data: [member.id, admin.id, outsider.id].flatMap((recipientId) => [
        { recipientId, type: "DEAL_STAGE_CHANGED", projectId: dealId, data: { project: dealName, stage: "Proposal" } },
        { recipientId, type: "DEAL_NEEDS_NEXT_STEP", projectId: dealId, data: { project: dealName } },
        { recipientId, type: "DEAL_STALLED", projectId: dealId, data: { project: dealName } },
        { recipientId, type: "TASK_ASSIGNED", projectId: dealId, taskId: kickoffTaskId, data: { title: taskTitle, project: dealName } },
        { recipientId, type: "ADDED_TO_PROJECT", projectId: dealId, data: { project: dealName, role: "EDITOR" } },
        { recipientId, type: "TASK_ASSIGNED", projectId: plain.id, taskId: plainTaskId, data: { title: plainTitle, project: `Packing ${tag}` } },
        { recipientId, type: "ADDED_TO_PROJECT", projectId: plain.id, data: { project: `Packing ${tag}`, role: "EDITOR" } },
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
    // APL-2716 AC3 supersedes the earlier "no" for a non-member under all: the bell matches main and names the deal.
    const bellOnly: { mode: Mode; who: { cookie: string }; user: string; visible: boolean; modeLabel: string; tc: string }[] = [
      { mode: "on", who: admin, user: "admin", visible: true, modeLabel: "all", tc: "qa:TC-APL2698-513157e4@v1" },
      { mode: "off", who: member, user: "member", visible: false, modeLabel: "off", tc: "qa:TC-APL2698-2c0a1372@v1" },
      { mode: "on", who: outsider, user: "member with no access to the deal", visible: true, modeLabel: "all", tc: "qa:TC-APL2716-a8042ed1@v1" },
    ];
    for (const row of bellOnly) {
      const server = running.get(row.mode)!;
      const bell = await call(server.base, row.who.cookie, "GET", "/api/notifications");
      const label = `${row.tc} mode=${row.modeLabel} user=${row.user} visible=${row.visible ? "yes" : "no"}`;
      expect(bell.status, label).toBe(200);
      assertBellDealName(bell.text, dealName, row.visible, label);
    }

    // APL-2716. Under admins a non-admin gets the generic sentence. Under all (this server is
    // CRM_VISIBLE=on, which crmMode reads as all) a non-member keeps main's sentence and href.
    // Off still redacts everyone, because the CRM is hidden. A non-deal task notice and a
    // non-deal ADDED_TO_PROJECT stay as stored. An on-deal ADDED_TO_PROJECT follows the deal.
    const dealHref = `/projects/${dealId}`;
    const taskHref = `/tasks/${kickoffTaskId}`;
    const plainHref = `/tasks/${plainTaskId}`;
    const plainProjectHref = `/projects/${plain.id}`;
    const controls: { mode: Mode; who: { cookie: string }; user: string; sees: boolean; tc: string }[] = [
      { mode: "on", who: admin, user: "admin", sees: true, tc: "qa:TC-APL2716-a8042ed1@v1" },
      { mode: "admins", who: admin, user: "admin", sees: true, tc: "qa:TC-APL2716-3abdb652@v1" },
      { mode: "off", who: admin, user: "admin", sees: false, tc: "qa:TC-APL2716-d2ec503b@v1" },
      { mode: "on", who: member, user: "on-deal member", sees: true, tc: "qa:TC-APL2716-a8042ed1@v1" },
      { mode: "admins", who: member, user: "member", sees: false, tc: "qa:TC-APL2716-3abdb652@v1" },
      { mode: "off", who: member, user: "on-deal member", sees: false, tc: "qa:TC-APL2716-d2ec503b@v1" },
      { mode: "on", who: outsider, user: "member with no access", sees: true, tc: "qa:TC-APL2716-a8042ed1@v1" },
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
      expect(page.items, label).toHaveLength(7);
      expect(page.unread, `${label} unread count`).toBe(7);
      expect(page.items, `qa:TC-APL2716-4811612d@v1 ${label}`).toContainEqual({ text: plainText, href: plainHref });
      expect(page.items, `${label} non-deal membership`).toContainEqual({ text: addedPlainText, href: plainProjectHref });
      if (row.sees) {
        expect(page.items, `qa:TC-APL2716-3abdb652@v1 ${label} deal name`).toContainEqual({ text: stageText, href: dealHref });
        expect(page.items, `qa:TC-APL2716-85782555@v1 ${label}`).toContainEqual({ text: nextStepText, href: dealHref });
        expect(page.items, `qa:TC-APL2716-fcc1861b@v1 ${label}`).toContainEqual({ text: stalledText, href: dealHref });
        expect(page.items, `${label} task title`).toContainEqual({ text: taskText, href: taskHref });
        expect(page.items, `${label} added to deal`).toContainEqual({ text: addedDealText, href: dealHref });
      } else {
        const hidden = page.items.filter((item) => item.text !== plainText && item.text !== addedPlainText);
        expect(hidden, label).toHaveLength(5);
        for (const item of hidden) {
          expect(item.text, `qa:TC-APL2716-3abdb652@v1 ${label}`).toBe(hiddenText);
          expect(item.href, `${label} href`).toBeNull();
        }
        expect(bell.text, `${label} deal name`).not.toContain(dealName);
        expect(page.items.map((item) => item.text), `${label} added to deal`).not.toContain(addedDealText);
        expect(bell.text, `${label} task title`).not.toContain(taskTitle);
        expect(bell.text, `${label} stage`).not.toContain("Proposal");
        expect(bell.text, `${label} deal href`).not.toContain(dealHref);
        expect(bell.text, `${label} task href`).not.toContain(taskHref);
        expect(bell.text, `qa:TC-APL2716-85782555@v1 ${label}`).not.toContain("needs a next step");
        expect(bell.text, `qa:TC-APL2716-fcc1861b@v1 ${label}`).not.toContain("no activity");
      }
    }

    // qa:TC-APL2698-be2ba3d5@v1 expected the name to be absent for a non-member under all.
    // APL-2716 AC3 (qa:TC-APL2716-a8042ed1@v1) requires that all and unset match main, so the name stays.
    // One real server per mode: admins, CRM_VISIBLE=all, and CRM_VISIBLE unset.
    const modeServers = [
      { label: "admins" as const, server: running.get("admins")!, redactNonAdmin: true },
      { label: "all" as const, server: extra.get("all")!, redactNonAdmin: false },
      { label: "unset" as const, server: extra.get("unset")!, redactNonAdmin: false },
    ];
    // The mode is the value passed to spawn; this test does not read another process's environment.
    expect(extra.get("all")!.env.CRM_VISIBLE).toBe("all");
    expect(extra.get("unset")!.env.CRM_VISIBLE).toBeUndefined();
    const readers = [
      { who: admin, user: "admin", nonAdmin: false },
      { who: member, user: "on-deal member", nonAdmin: true },
      { who: outsider, user: "non-member", nonAdmin: true },
    ];
    for (const row of modeServers) {
      for (const reader of readers) {
        const redacted = row.redactNonAdmin && reader.nonAdmin;
        const bell = await call(row.server.base, reader.who.cookie, "GET", "/api/notifications");
        const label = `qa:TC-APL2716-a8042ed1@v1 mode=${row.label} user=${reader.user} redacted=${redacted ? "yes" : "no"}`;
        expect(bell.status, label).toBe(200);
        const page = bellItems(bell.text);
        expect(page.items, label).toHaveLength(7);
        expect(page.unread, `${label} unread count`).toBe(7);
        expect(page.items, `qa:TC-APL2716-4811612d@v1 ${label}`).toContainEqual({ text: plainText, href: plainHref });
        expect(page.items, `${label} non-deal membership`).toContainEqual({ text: addedPlainText, href: plainProjectHref });
        if (!redacted) {
          expect(page.items, `qa:TC-APL2716-3abdb652@v1 ${label}`).toContainEqual({ text: stageText, href: dealHref });
          expect(page.items, `qa:TC-APL2716-85782555@v1 ${label}`).toContainEqual({ text: nextStepText, href: dealHref });
          expect(page.items, `qa:TC-APL2716-fcc1861b@v1 ${label}`).toContainEqual({ text: stalledText, href: dealHref });
          expect(page.items, `${label} task title`).toContainEqual({ text: taskText, href: taskHref });
          expect(page.items, `${label} added to deal`).toContainEqual({ text: addedDealText, href: dealHref });
        } else {
          const hidden = page.items.filter((item) => item.text !== plainText && item.text !== addedPlainText);
          expect(hidden, label).toHaveLength(5);
          for (const item of hidden) {
            expect(item.text, `qa:TC-APL2716-3abdb652@v1 ${label}`).toBe(hiddenText);
            expect(item.href, `${label} href`).toBeNull();
          }
          expect(bell.text, `qa:TC-APL2716-d2ec503b@v1 ${label} deal name`).not.toContain(dealName);
          expect(page.items.map((item) => item.text), `${label} added to deal`).not.toContain(addedDealText);
          expect(bell.text, `${label} task title`).not.toContain(taskTitle);
          expect(bell.text, `${label} stage`).not.toContain("Proposal");
          expect(bell.text, `${label} deal href`).not.toContain(dealHref);
          expect(bell.text, `${label} task href`).not.toContain(taskHref);
          expect(bell.text, `qa:TC-APL2716-85782555@v1 ${label}`).not.toContain("needs a next step");
          expect(bell.text, `qa:TC-APL2716-fcc1861b@v1 ${label}`).not.toContain("no activity");
        }
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

    // Mode, outbox and base are the values passed to spawn. The deal API is how that mode shows up.
    const open = running.get("on");
    expect(open, "the on server is running").toBeTruthy();
    const memberEmail = `nakul17+zz-2728-${runId}-mode-member@aplyd.com`;
    const adminEmail = `nakul17+zz-2728-${runId}-mode-admin@aplyd.com`;
    seed.emails.push(memberEmail, adminEmail);
    const member = await signIn(open!, `ZZ-TEST mode member ${runId}`, memberEmail);
    const admin = await signIn(open!, `ZZ-TEST mode admin ${runId}`, adminEmail);
    seed.userIds.push(member.id, admin.id);
    await promoteToAdmin(open!, admin.id);

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
      // SHO-2771: this used to read /proc/net/tcp and /proc/<pid>/fd to name the pid holding the port,
      // which is why the tier could only run on Linux. The port answers or it does not (a TCP connect),
      // and the pid is the one startModeServer spawned in its own process group.
      expect(await portAnswers(server.port), `${server.mode} is listening`).toBe(true);
      listeners.push(server.pid);
    }
    expect(new Set(listeners).size, "no mode reuses another mode's process").toBe(listeners.length);
    expect(new Set([...running.values()].map((server) => server.port)).size, "each mode has its own port").toBe(running.size);
    const modes = new Set([...running.values()].map((server) => server.mode));
    expect(modes).toEqual(new Set(MODES));

    await expect(startModeServer("on", { bin: process.execPath, args: ["-e", "process.exit(1)"], timeoutMs: 3_000 })).rejects.toThrow(/cannot start/);
    await expect(startModeServer("off", { bin: process.execPath, args: ["-e", "setInterval(() => {}, 1e9)"], timeoutMs: 800 })).rejects.toThrow(/cannot start/);
  }, 60_000);

  it("qa:TC missing APL-2891: when one server rejects at start-up, the started ones are closed and no sho-crm outbox is left", async () => {
    const crmDirs = () => new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("sho-crm-")));
    const before = crmDirs();
    // A stand-in server that answers /api/health on the PORT startModeServer gives it.
    const healthy = { bin: process.execPath, args: ["-e", "require('http').createServer((q, s) => s.end('ok')).listen(+process.env.PORT, '127.0.0.1')"] };
    let started: Running | undefined;
    await expect(startServers([
      async () => (started = await startModeServer("on", healthy)),
      () => startModeServer("off", { bin: process.execPath, args: ["-e", "process.exit(1)"], timeoutMs: 3_000 }),
    ])).rejects.toThrow(/cannot start/);
    expect(started, "the healthy server started before the other rejected").toBeTruthy();
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    await expect.poll(() => alive(started!.pid), { timeout: 5_000 }).toBe(false);
    await expect.poll(() => fetch(`${started!.base}/api/health`).then(() => "open", () => "closed"), { timeout: 5_000 }).toBe("closed");
    expect([...crmDirs()].filter((name) => !before.has(name))).toEqual([]);
  }, 30_000);

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
    await promoteToAdmin(open!, admin.id);

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

  it("qa:TC missing AC1 AC2 AC3: Deactivate 409 hides deal names from a caller who cannot see the CRM (APL-2735 AC1-AC3)", async () => {
    const open = running.get("on");
    expect(open, "the on server is running").toBeTruthy();
    const dealNames = [`ZZ-TEST Northwind ${tag}`, `ZZ-TEST Contoso ${tag}`];
    const leaderEmail = `nakul17+zz-2735-${runId}-leader@aplyd.com`;
    const adminEmail = `nakul17+zz-2735-${runId}-admin@aplyd.com`;
    const memberEmail = `nakul17+zz-2735-${runId}-member@aplyd.com`;
    seed.emails.push(leaderEmail, adminEmail, memberEmail);
    const leader = await signIn(open!, `ZZ-TEST leader ${runId}`, leaderEmail);
    const admin = await signIn(open!, `ZZ-TEST admin ${runId}`, adminEmail);
    const member = await signIn(open!, `ZZ-TEST member ${runId}`, memberEmail);
    seed.userIds.push(leader.id, admin.id, member.id);
    await db.user.update({ where: { id: admin.id }, data: { orgRole: "ADMIN" } });

    const pipes = await call(open!.base, admin.cookie, "GET", "/api/deals/pipelines");
    expect(pipes.status, pipes.text).toBe(200);
    const pipe = (pipes.json?.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
    expect(pipe?.id).toBeTruthy();
    const org = await call(open!.base, admin.cookie, "POST", "/api/orgs", { name: `ZZ-TEST Buyer ${tag} deactivate` });
    expect(org.status, org.text).toBe(201);
    const organisationId = (org.json?.organisation as { id: string }).id;
    seed.orgIds.push(organisationId);

    const dealIds: string[] = [];
    for (const name of dealNames) {
      const made = await call(open!.base, admin.cookie, "POST", "/api/deals", {
        name, organisationId, pipelineId: pipe!.id, leaderId: leader.id, whyPursue: tag,
        nextStep: { title: `ZZ-TEST step ${tag}`, dueDate: istDate(4) },
      });
      expect(made.status, made.text).toBe(201);
      const id = (made.json?.deal as { id: string }).id;
      dealIds.push(id);
      seed.projectIds.push(id);
    }
    expect(dealIds).toHaveLength(2);

    // Same sentence main returns, plus the leads the caller is allowed to see.
    const assertDetail = (text: string, json: Record<string, unknown> | null) => {
      const leads = json?.leads as { id: string; name: string }[];
      expect(json?.error).toBe("Name a new Leader first for: " + leads.map((row) => row.name).join(", "));
      expect(leads).toHaveLength(2);
      expect(leads).toEqual(expect.arrayContaining(dealIds.map((id, i) => ({ id, name: dealNames[i] }))));
      for (const name of dealNames) expect(text).toContain(name);
      for (const id of dealIds) expect(text).toContain(id);
    };
    // No deal name, id, or count. Two deals would show up as "2" or a second leads row.
    const assertGeneric = (text: string, json: Record<string, unknown> | null) => {
      expect(json).toEqual({ error: "Name a new Leader first." });
      expect(text).not.toMatch(/\b2\b/);
      for (const name of dealNames) expect(text).not.toContain(name);
      for (const id of dealIds) expect(text).not.toContain(id);
    };

    let allServer: Running | undefined;
    try {
      allServer = await startModeServer("all" as Mode);
      // Admin is the CRM caller except under off, where nobody can see the CRM.
      // A member cannot deactivate anyone, so the body is the 403 and never the leader list.
      const cases: { mode: string; server: Running; user: "admin" | "member"; kind: "detail" | "generic" | "forbidden" }[] = [
        { mode: "on", server: open!, user: "admin", kind: "detail" },
        { mode: "on", server: open!, user: "member", kind: "forbidden" },
        { mode: "all", server: allServer, user: "admin", kind: "detail" },
        { mode: "all", server: allServer, user: "member", kind: "forbidden" },
        { mode: "admins", server: running.get("admins")!, user: "admin", kind: "detail" },
        { mode: "admins", server: running.get("admins")!, user: "member", kind: "forbidden" },
        { mode: "off", server: running.get("off")!, user: "admin", kind: "generic" },
        { mode: "off", server: running.get("off")!, user: "member", kind: "forbidden" },
      ];
      const people = { admin, member };
      for (const example of cases) {
        const who = people[example.user];
        const res = await call(example.server.base, who.cookie, "POST", `/api/team/${leader.id}/deactivate`, { reassign: "leaders" });
        const label = `CRM_VISIBLE=${example.mode} ${example.user} ${res.text}`;
        if (example.kind === "detail") {
          expect(res.status, label).toBe(409);
          assertDetail(res.text, res.json);
        } else if (example.kind === "generic") {
          expect(res.status, label).toBe(409);
          assertGeneric(res.text, res.json);
        } else {
          expect(res.status, label).toBe(403);
          expect(res.json).toEqual({ error: "You cannot deactivate this person." });
          for (const name of dealNames) expect(res.text, label).not.toContain(name);
          for (const id of dealIds) expect(res.text, label).not.toContain(id);
        }
      }
      expect((await db.user.findUnique({ where: { id: leader.id }, select: { deactivatedAt: true } }))?.deactivatedAt).toBeNull();
    } finally {
      if (allServer) killGroup(allServer.pid);
    }
  }, 120_000);
});
