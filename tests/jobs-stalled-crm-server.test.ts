// APL-2741. Each CRM_VISIBLE mode is its own `next start` process, started with that mode's env.
// unset deletes CRM_VISIBLE. all, admins and off set it. The test process never switches a running server.
// POST /api/jobs/stalled-deals uses a test-only token defined here. A short or missing parent JOB_SECRET
// does not skip this file: the child always receives the test token, and a dead server fails the run.
// Rows are checked in the local test database and on GET /api/notifications. The job sends no email.
// Names are ZZ-TEST. Addresses are nakul17+ aliases.
// The child's env is never read from /proc. Its mode and job token are proven by how it answers.
// qa:TC missing: QA has not assigned TC ids for this story yet.
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
import { ageDeals, clearNotesFor, setOrgRole } from "./stalled-crm-fixture";
import { assertProcfs } from "./procfs-precondition";

const root = fileURLToPath(new URL("..", import.meta.url));
const LOAD = 40;
/** Fake token for the spawned servers only. Never a real job secret, and never printed. */
const TEST_JOB_SECRET = "test-only-job-secret-012345";

type Mode = "unset" | "all" | "admins" | "off";
type Running = { mode: Mode; port: number; pid: number; outbox: string; base: string };
type Who = { id: string; cookie: string };
type DealFix = { id: string; name: string; title: string };

const runId = `${Date.now().toString(36)}-${process.pid}`;
const tag = `ZZ-TEST-${runId}`;
const owned: DealFix = { id: "", name: `ZZ-TEST Acme renewal ${tag}`, title: `ZZ-TEST Acme kickoff ${tag}` };
const adminDeal: DealFix = { id: "", name: `ZZ-TEST Admin renewal ${tag}`, title: `ZZ-TEST Admin kickoff ${tag}` };
const rootDeal: DealFix = { id: "", name: `ZZ-TEST Root renewal ${tag}`, title: `ZZ-TEST Root kickoff ${tag}` };

const spawned = new Set<number>();
let owner: Who;
let follower: Who;
let orgAdmin: Who;
let superLead: Who;

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
    throw new Error("Refusing to run: stalled-deal tests use the local test database only");
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

function stopServer(server: Running | null) {
  if (!server || server.pid === process.pid || server.pid < 2) return;
  const listeners = listeningPids(server.port).filter((pid) => pid !== process.pid && isInGroup(server.pid, pid));
  const targets = [...new Set([...descendantPids(server.pid), ...listeners, server.pid])].filter((pid) => pid > 1 && pid !== process.pid);
  for (const pid of targets) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  spawned.delete(server.pid);
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

async function startModeServer(mode: Mode): Promise<Running> {
  if (TEST_JOB_SECRET.length < 16) throw new Error("The test-only job token must be at least 16 characters");
  const port = await freePort();
  const outbox = mkdtempSync(path.join(tmpdir(), `sho-stalled-${mode}-`));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    EMAIL_OUTBOX_DIR: outbox,
    APP_URL: `http://127.0.0.1:${port}`,
    PORT: String(port),
    SUPER_ADMIN_EMAILS: "root.test@aplyd.com",
    JOB_SECRET: TEST_JOB_SECRET,
  };
  delete env.CRM_VISIBLE;
  if (mode !== "unset") env.CRM_VISIBLE = mode;
  const logFd = openSync(path.join(outbox, "server.log"), "a");
  const child = spawn("npx", ["next", "start", "-H", "127.0.0.1", "-p", String(port)], {
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

async function makeDeal(server: Running, who: Who, deal: DealFix) {
  const pipes = await call(server.base, who.cookie, "GET", "/api/deals/pipelines");
  expectStatus(pipes, 200, "pipelines");
  const pipe = (pipes.json?.pipelines as { id: string; key: string }[]).find((p) => p.key === "DEAL_PROACTIVE");
  expect(pipe?.id).toBeTruthy();
  const org = await call(server.base, who.cookie, "POST", "/api/orgs", { name: `ZZ-TEST Org ${deal.name}` });
  expectStatus(org, 201, "org");
  const made = await call(server.base, who.cookie, "POST", "/api/deals", {
    name: deal.name,
    organisationId: (org.json?.organisation as { id: string }).id,
    pipelineId: pipe!.id,
    leaderId: who.id,
    whyPursue: "ZZ-TEST fit",
    nextStep: { title: deal.title, dueDate: istDate(14) },
  });
  expectStatus(made, 201, "deal");
  deal.id = (made.json?.deal as { id: string }).id;
  expect(deal.id).toBeTruthy();
}

async function addEditor(server: Running, leader: Who, dealId: string, userId: string) {
  expectStatus(await call(server.base, leader.cookie, "POST", `/api/projects/${dealId}/members`, { userId, role: "EDITOR" }), 201, "member");
}

async function seed(server: Running) {
  const mail = (slug: string) => `nakul17+zz-2741-${runId}-${slug}@aplyd.com`;
  owner = await signIn(server, `ZZ-TEST owner ${tag}`, mail("owner"));
  follower = await signIn(server, `ZZ-TEST follower ${tag}`, mail("follower"));
  orgAdmin = await signIn(server, `ZZ-TEST admin ${tag}`, mail("admin"));
  superLead = await signIn(server, `ZZ-TEST super ${tag}`, mail("super"));
  await setOrgRole(orgAdmin.id, "ADMIN");
  await setOrgRole(superLead.id, "SUPER_ADMIN");
  await makeDeal(server, owner, owned);
  await makeDeal(server, orgAdmin, adminDeal);
  await makeDeal(server, superLead, rootDeal);
  await addEditor(server, owner, owned.id, follower.id);
  await addEditor(server, orgAdmin, adminDeal.id, follower.id);
  await addEditor(server, superLead, rootDeal.id, follower.id);
  await addEditor(server, orgAdmin, adminDeal.id, owner.id);
  await addEditor(server, superLead, rootDeal.id, owner.id);
  // Same three deals, same 31-day age, same column order as seedStalledWorld's fixture.
  await ageDeals({ owned, adminDeal, rootDeal });
}

const people = () => [owner, follower, orgAdmin, superLead];
const deals = () => [owned, adminDeal, rootDeal];

async function clearNotes() {
  await clearNotesFor(people().map((p) => p.id));
}

async function storedRows(recipientId: string) {
  return db.notification.findMany({
    where: { recipientId },
    select: { recipientId: true, type: true, actorId: true, taskId: true, projectId: true, data: true },
    orderBy: { createdAt: "asc" },
  });
}

async function bell(base: string, who: Who) {
  const result = await call(base, who.cookie, "GET", "/api/notifications?limit=200");
  expectStatus(result, 200, "bell");
  return (result.json?.items ?? []) as { text: string; href: string | null }[];
}

function needles() {
  const out: string[] = [];
  for (const deal of deals()) out.push(deal.name, deal.title, deal.id, `/projects/${deal.id}`);
  return out;
}

async function expectNoDealNotice(base: string, who: Who) {
  const rows = await storedRows(who.id);
  const blob = JSON.stringify(rows);
  const items = JSON.stringify(await bell(base, who));
  for (const needle of needles()) {
    expect(blob, `row ${needle}`).not.toContain(needle);
    expect(items, `bell ${needle}`).not.toContain(needle);
  }
}

async function expectStalledNotice(base: string, who: Who, deal: DealFix, exact: boolean) {
  const rows = await storedRows(who.id);
  const mine = rows.filter((row) => row.type === "DEAL_STALLED" && row.projectId === deal.id);
  expect(mine.length).toBeGreaterThanOrEqual(1);
  if (exact) expect(rows).toEqual(mine);
  if (exact) expect(mine).toHaveLength(1);
  expect(mine[0]).toEqual({
    recipientId: who.id, type: "DEAL_STALLED", actorId: null, taskId: null, projectId: deal.id, data: { project: deal.name },
  });
  expect(JSON.stringify(mine)).not.toContain(deal.title);
  const items = (await bell(base, who)).filter((item) => item.href === `/projects/${deal.id}`);
  expect(items.length).toBeGreaterThanOrEqual(1);
  if (exact) expect(items).toHaveLength(1);
  expect(items[0]?.text).toBe(`"${deal.name}" has had no activity for 30 days.`);
  expect(items[0]?.text ?? "").not.toContain(deal.title);
}

function expectNoDealMail(outbox: string) {
  const files = readdirSync(outbox).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const text = readFileSync(path.join(outbox, file), "utf8");
    for (const needle of needles()) expect(text.includes(needle), `email names a deal`).toBe(false);
  }
}

async function expectOwnProcess(server: Running) {
  expect(server.pid).not.toBe(process.pid);
  const listeners = listeningPids(server.port).filter((pid) => isInGroup(server.pid, pid));
  expect(listeners.length, `${server.mode} is listening`).toBeGreaterThan(0);
  // The child holds the test-only token, not the parent's: anything else is refused.
  const refused = async (headers: Record<string, string>) => {
    const res = await fetch(`${server.base}/api/jobs/stalled-deals`, { method: "POST", headers });
    const text = await res.text();
    expect(text.includes(TEST_JOB_SECRET)).toBe(false);
    return res.status;
  };
  expect(await refused({}), "no token").toBe(401);
  expect(await refused({ authorization: `Bearer ${"x".repeat(TEST_JOB_SECRET.length)}` }), "wrong token").toBe(401);
  const parentSecret = process.env.JOB_SECRET;
  if (parentSecret && parentSecret !== TEST_JOB_SECRET) {
    expect(await refused({ authorization: `Bearer ${parentSecret}` }), "parent token").toBe(401);
  }
}

/** Sets this process's CRM_VISIBLE to a mode that contradicts the server's while fn runs. */
async function withContraryParentMode(server: Running, fn: () => Promise<void>) {
  const previous = process.env.CRM_VISIBLE;
  process.env.CRM_VISIBLE = server.mode === "off" ? "all" : "off";
  try { await fn(); } finally {
    if (previous === undefined) delete process.env.CRM_VISIBLE;
    else process.env.CRM_VISIBLE = previous;
  }
}

async function postJob(base: string, count: number) {
  const responses = await Promise.all(Array.from({ length: count }, () => fetch(`${base}/api/jobs/stalled-deals`, {
    method: "POST",
    headers: { authorization: `Bearer ${TEST_JOB_SECRET}` },
  })));
  expect(responses).toHaveLength(count);
  for (const res of responses) {
    const text = await res.text();
    expect(text.includes(TEST_JOB_SECRET)).toBe(false);
    expect(res.status, scrub(text).slice(0, 180)).toBe(200);
    const body = JSON.parse(text) as { status?: string; result?: { notified?: number; skipped?: boolean } };
    expect(body.status).toBe("OK");
    expect(typeof body.result?.notified).toBe("number");
  }
}

async function expectMode(base: string, mode: Mode, exact: boolean) {
  if (mode === "unset" || mode === "all") {
    await expectStalledNotice(base, owner, owned, exact);
    await expectStalledNotice(base, orgAdmin, adminDeal, exact);
    await expectStalledNotice(base, superLead, rootDeal, exact);
    await expectNoDealNotice(base, follower);
  } else if (mode === "admins") {
    await expectNoDealNotice(base, owner);
    await expectNoDealNotice(base, follower);
    await expectStalledNotice(base, orgAdmin, adminDeal, exact);
    await expectStalledNotice(base, superLead, rootDeal, exact);
  } else {
    for (const who of people()) await expectNoDealNotice(base, who);
  }
}

async function runMode(mode: Mode) {
  const server = await startModeServer(mode);
  try {
    await expectOwnProcess(server);
    await clearNotes();
    // The rows must follow the server's own mode even while this process says the opposite.
    await withContraryParentMode(server, async () => {
      await postJob(server.base, 1);
      await expectMode(server.base, mode, true);
    });
    expectNoDealMail(server.outbox);
    await clearNotes();
    await postJob(server.base, LOAD);
    await expectMode(server.base, mode, false);
    expectNoDealMail(server.outbox);
  } finally {
    stopServer(server);
  }
}

describe("qa:TC missing APL-2741 stalled-deal jobs are one server process per CRM_VISIBLE mode", () => {
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
    if (owner?.id) {
      await clearNotesFor(people().map((p) => p.id));
    }
    await db.$disconnect();
  });

  it("qa:TC missing AC2: unset server matches today, including 40 concurrent job posts", async () => {
    await runMode("unset");
  });

  it("qa:TC missing AC2: CRM_VISIBLE=all server matches today, including 40 concurrent job posts", async () => {
    await runMode("all");
  });

  it("qa:TC missing AC1 AC2: admins server: a non-admin gets no deal notice and an admin still does", async () => {
    await runMode("admins");
  });

  it("qa:TC missing AC1: off server: nobody gets a stalled-deal notice", async () => {
    await runMode("off");
  });
});
