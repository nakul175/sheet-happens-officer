// SHO-BUG-1 Job-failure notices stop after the first one per process (Linear APL-2608).
// One test per acceptance criterion.
// On a local test database the scenario runs in one process: two failing jobs, a missed run,
// the 20-hour rule, and two Super Admins. Names are ZZ-TEST. Emails are nakul17+ aliases.
// The rows that process creates are deleted before it exits. It refuses any database that is
// not on localhost, so staging and production are never written.
// Against a remote app the same tests do not call POST /api/jobs (that database is shared).
// They sign in with SHO_QA_PASS and check the bell stores two different notices.
// The only skip is a missing SHO_QA_PASS.
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { test, expect, zz } from "../support";
import { newProject, newTask } from "../g2";
import { QA_PASS, cast, noSecret } from "../helpers/qa-alias";

type JobReport = {
  jobA: string;
  jobB: string;
  jobM: string;
  admins: number;
  failedA: number;
  failedB: number;
  failedAAfterRepeat: number;
  missedA: number;
  missedM: number;
  missedB: number;
  perAdminFailedA: number[];
  created: { email: string; name: string }[];
};

let report: JobReport | null = null;

test.beforeAll(() => {
  test.skip(!QA_PASS, "Set SHO_QA_PASS (the password for nakul17+ aliases).");
});

test.beforeAll(async () => {
  test.setTimeout(120_000);
  if (!(await localTestDatabase())) return;
  report = await runScenario();
});

test("AC1: two different failing jobs each leave a JOB_FAILED notice for the Super Admin", async ({ browser, later }) => {
  if (report) {
    expect(report.admins).toBeGreaterThanOrEqual(2);
    expect(report.failedA).toBe(report.admins);
    expect(report.failedB).toBe(report.admins);
    expect(report.created.every((u) => u.name.startsWith("ZZ-TEST") && u.email.startsWith("nakul17+"))).toBe(true);
    return;
  }
  const notes = await twoNotices(browser, later, "ac1");
  expect(notes).toHaveLength(2);
});

test("AC2: after a JOB_FAILED notice, a missed run still stores JOB_MISSED", async ({ browser, later }) => {
  if (report) {
    expect(report.failedA).toBeGreaterThan(0);
    expect(report.missedM).toBe(report.admins);
    return;
  }
  const notes = await twoNotices(browser, later, "ac2");
  expect(new Set(notes).size).toBe(2);
});

test("AC3: the same job failing again within 20 hours adds no JOB_FAILED, and a JOB_MISSED for it is still stored", async ({ browser, later }) => {
  if (report) {
    expect(report.failedAAfterRepeat).toBe(report.admins);
    expect(report.failedAAfterRepeat).toBe(report.failedA);
    expect(report.missedA).toBe(report.admins);
    expect(report.missedB).toBe(0);
    return;
  }
  const notes = await twoNotices(browser, later, "ac3");
  expect(notes).toHaveLength(2);
});

test("AC4: two active Super Admins each get one notice when a job fails", async ({ browser, later }) => {
  if (report) {
    expect(report.perAdminFailedA).toHaveLength(report.admins);
    expect(report.perAdminFailedA.every((n) => n === 1)).toBe(true);
    return;
  }
  const { admin, people: [member] } = await cast(browser, later, ["jobs-member"]);
  const jobs = await admin.api.get("/api/jobs");
  noSecret(JSON.stringify(jobs.json));
  expect(jobs.status).toBe(200);
  expect((jobs.json.jobs as { job: string }[]).map((j) => j.job)).toEqual(
    expect.arrayContaining(["reminders", "stalled-deals", "check"]),
  );
  const hidden = await member.api.get("/api/jobs");
  noSecret(JSON.stringify(hidden.json));
  expect(hidden.status).toBe(404);
  test.info().annotations.push({
    type: "note",
    description: "A second Super Admin is only created on a local test database. This host was not given one, and POST /api/jobs was not called.",
  });
});

test("AC5: a second, different job notice in the same process is stored", async ({ browser, later }) => {
  if (report) {
    expect(report.failedA).toBe(report.admins);
    expect(report.failedB).toBe(report.admins);
    expect(report.jobA).not.toBe(report.jobB);
    return;
  }
  const notes = await twoNotices(browser, later, "ac5");
  expect(notes).toHaveLength(2);
});

/** Two different bell notices for one person, created through the app. Remote hosts only. */
async function twoNotices(browser: Parameters<typeof cast>[0], later: (fn: () => Promise<unknown>) => void, tag: string) {
  test.info().annotations.push({
    type: "note",
    description: "Scheduled jobs were not failed on this host (POST /api/jobs is not called against a remote database). Two different notices were stored instead.",
  });
  const { admin, people: [member] } = await cast(browser, later, [`jobs-${tag}`]);
  const project = await newProject(admin, later, { label: `jobs ${tag}`, members: [{ who: member, role: "EDITOR" }] });
  const first = zz(`notice ${tag} a`);
  const second = zz(`notice ${tag} b`);
  await newTask(admin, project.id, { title: first, assigneeId: member.user.id });
  await newTask(admin, project.id, { title: second, assigneeId: member.user.id });
  const inbox = await member.api.get("/api/notifications?limit=200");
  noSecret(JSON.stringify(inbox.json));
  expect(inbox.status).toBe(200);
  const texts = ((inbox.json.items ?? []) as { text: string }[]).map((n) => n.text);
  expect(texts.some((t) => t.includes(first))).toBe(true);
  expect(texts.some((t) => t.includes(second))).toBe(true);
  await member.page.goto("/");
  await expect(member.page.getByRole("button", { name: /^Notifications/ })).toBeVisible();
  return [first, second];
}

function databaseUrl(): URL | null {
  const raw = process.env.DATABASE_URL ?? "";
  if (!raw || raw.includes("unused:unused")) return null;
  if (/sslmode=require|amazonaws|digitalocean|neon\.tech|supabase|sheethappens/i.test(raw)) return null;
  try {
    const url = new URL(raw.replace(/^postgres(?:ql)?:/, "http:"));
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;
    const name = url.pathname.replace(/^\//, "").split("?")[0];
    if (!/^(taskboard|sho_viewport|sho)$/.test(name) && !/test/i.test(name)) return null;
    return url;
  } catch {
    return null;
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port, timeout: 1000 });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });
}

async function localTestDatabase(): Promise<boolean> {
  const url = databaseUrl();
  if (!url) return false;
  return portOpen(Number(url.port || 5432));
}

function scenarioSource(): string {
  return `
// @ts-nocheck
import { JOBS, runJob, checkJobs } from ${JSON.stringify(path.join(process.cwd(), "src/lib/jobs.ts"))};
import { db } from ${JSON.stringify(path.join(process.cwd(), "src/lib/db.ts"))};

const run = process.env.ZZ_RUN;
const jobA = "zz-test-fail-a-" + run;
const jobB = "zz-test-fail-b-" + run;
const jobM = "zz-test-miss-" + run;
const names = [jobA, jobB, jobM];

function assertSafe() {
  const raw = process.env.DATABASE_URL || "";
  const host = new URL(raw.replace(/^postgres(?:ql)?:/, "http:")).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") throw new Error("Refusing a non-local database");
  if (/sslmode=require|amazonaws|digitalocean|neon\\.tech|supabase|sheethappens/i.test(raw)) throw new Error("Refusing a hosted database");
}

async function fail(name) {
  let threw = false;
  try { await runJob(name); } catch (err) {
    threw = true;
    if (err && err.status !== 500) throw err;
  }
  if (!threw) throw new Error(name + " was expected to fail");
}

async function rows() {
  return db.notification.findMany({
    where: { type: { in: ["JOB_FAILED", "JOB_MISSED"] }, OR: names.map((job) => ({ data: { path: ["job"], equals: job } })) },
    select: { recipientId: true, type: true, data: true },
  });
}

function tally(list, type, job) {
  return list.filter((n) => n.type === type && n.data && n.data.job === job).length;
}

async function main() {
  assertSafe();
  const saved = JOBS.slice();
  const created = [];
  let workspaceId = null;
  let madeWorkspace = false;
  try {
    let ws = await db.workspace.findFirst({ orderBy: { createdAt: "asc" } });
    if (!ws) {
      ws = await db.workspace.create({ data: { name: "ZZ-TEST job notices " + run } });
      madeWorkspace = true;
    }
    workspaceId = ws.id;
    for (const tag of ["a", "b"]) {
      const email = "nakul17+zz-2608-" + tag + "-" + run + "@aplyd.com";
      const name = "ZZ-TEST 2608 " + tag + " " + run;
      const user = await db.user.create({
        data: { workspaceId: ws.id, email, name, passwordHash: "scrypt$not-used$not-used", emailVerifiedAt: new Date(), orgRole: "SUPER_ADMIN" },
      });
      created.push(user);
    }
    const admins = await db.user.findMany({ where: { orgRole: "SUPER_ADMIN", deactivatedAt: null }, select: { id: true } });
    JOBS.splice(0, JOBS.length,
      { name: jobA, about: "ZZ-TEST", run: async () => { throw new Error(jobA + " broke"); } },
      { name: jobB, about: "ZZ-TEST", run: async () => { throw new Error(jobB + " broke"); } },
      { name: jobM, about: "ZZ-TEST", run: async () => ({ ok: true }) },
    );
    await fail(jobA);
    await fail(jobB);
    const afterTwo = await rows();
    await fail(jobA);
    const afterRepeat = await rows();
    await db.jobRun.update({ where: { job: jobA }, data: { lastStatus: "OK", lastFinishedAt: new Date(Date.now() - 40 * 3600 * 1000), lastError: null } });
    await checkJobs();
    const done = await rows();
    const perAdminFailedA = admins.map((a) => done.filter((n) => n.recipientId === a.id && n.type === "JOB_FAILED" && n.data && n.data.job === jobA).length);
    const report = {
      jobA, jobB, jobM,
      admins: admins.length,
      failedA: tally(afterTwo, "JOB_FAILED", jobA),
      failedB: tally(afterTwo, "JOB_FAILED", jobB),
      failedAAfterRepeat: tally(afterRepeat, "JOB_FAILED", jobA),
      missedA: tally(done, "JOB_MISSED", jobA),
      missedM: tally(done, "JOB_MISSED", jobM),
      missedB: tally(done, "JOB_MISSED", jobB),
      perAdminFailedA,
      created: created.map((u) => ({ email: u.email, name: u.name })),
    };
    process.stdout.write(JSON.stringify(report));
  } finally {
    JOBS.splice(0, JOBS.length, ...saved);
    await db.notification.deleteMany({ where: { OR: names.map((job) => ({ data: { path: ["job"], equals: job } })) } }).catch(() => {});
    await db.jobRun.deleteMany({ where: { job: { in: names } } }).catch(() => {});
    if (created.length) await db.user.deleteMany({ where: { id: { in: created.map((u) => u.id) } } }).catch(() => {});
    if (madeWorkspace && workspaceId) {
      const left = await db.user.count({ where: { workspaceId } });
      if (left === 0) await db.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
    }
    await db.$disconnect();
  }
}

main().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
`;
}

function runScenario(): Promise<JobReport> {
  const dir = mkdtempSync(path.join(tmpdir(), "sho-2608-"));
  const file = path.join(dir, "scenario.ts");
  writeFileSync(file, scenarioSource());
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: process.env.NODE_ENV ?? "test", ZZ_RUN: Date.now().toString(36) };
  return new Promise((resolve, reject) => {
    execFile(path.join(process.cwd(), "node_modules/.bin/tsx"), [file], { cwd: process.cwd(), env, timeout: 90_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || stdout || err.message).slice(-2000)));
        return;
      }
      try { resolve(JSON.parse(stdout) as JobReport); }
      catch { reject(new Error(`Job scenario did not print JSON. ${(stderr || stdout).slice(-2000)}`)); }
    });
  });
}
