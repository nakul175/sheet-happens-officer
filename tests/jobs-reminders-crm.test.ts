// APL-2729. Library check: sendReminders applies crmProjectWhere for the assignee.
// AC4 (one real server process per CRM_VISIBLE mode, including 40 concurrent POSTs) lives in
// tests/jobs-reminders-crm-server.test.ts and runs in CI via `npm run test:reminder-modes`.
// The shared test server stays on the default CRM_VISIBLE (unset), so a deal can be seeded.
// Rows are checked in the test database and on GET /api/notifications. Names are ZZ-TEST.
// A non-local database is refused.
//
// qa:TC missing unset
// qa:TC missing all
// qa:TC missing admins / member
// qa:TC missing admins / admin
// qa:TC missing off
// qa:TC missing non-deal ops check
// qa:TC missing 40 concurrent reminder requests
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crmMode } from "../src/lib/crm";
import { startOfTodayIST } from "../src/lib/dates";
import { reminderTaskWhere, sendReminders } from "../src/lib/jobs";
import { db } from "./concierge-helpers";
import { account, admin, istDate, project, superAdmin, task, type Account } from "./helpers";

const DUE = ["TASK_DUE_TOMORROW", "TASK_DUE_TODAY", "TASK_OVERDUE"] as const;
const LOAD = 40;

type Mode = "unset" | "all" | "admins" | "off";
type BellItem = { text: string; href: string | null };

const tag = `ZZ-TEST-${Date.now().toString(36)}-${process.pid}`;
const dealName = `ZZ-TEST Acme renewal ${tag}`;
const memberTitle = `ZZ-TEST Acme kickoff ${tag}`;
const adminTitle = `ZZ-TEST Acme kickoff ${tag} admin`;
const opsTitle = `ZZ-TEST Ops check ${tag}`;

let member: Account;
let dealAdmin: Account;
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

async function withMode(mode: Mode, fn: () => Promise<void>) {
  const prev = process.env.CRM_VISIBLE;
  if (mode === "unset") delete process.env.CRM_VISIBLE;
  else process.env.CRM_VISIBLE = mode;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.CRM_VISIBLE;
    else process.env.CRM_VISIBLE = prev;
  }
}

/** Drop every notice for these throwaway people so the bell shows only what the job just wrote. */
async function clearReminders() {
  await db.notification.deleteMany({ where: { recipientId: { in: [member.id, dealAdmin.id] } } });
}

async function dueRows(recipientId: string) {
  return db.notification.findMany({
    where: { recipientId, type: { in: [...DUE] } },
    select: { recipientId: true, type: true, taskId: true, projectId: true, data: true },
  });
}

async function bell(who: Account) {
  const r = await who.c.get("/api/notifications?limit=200");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.items as BellItem[];
}

/** No reminder row, and no bell item, carries the deal, its task, or a link to either. */
async function expectNoDealReminder(who: Account) {
  const rows = await dueRows(who.id);
  const leaked = rows.filter((row) => {
    const blob = JSON.stringify(row);
    return row.taskId === memberTaskId || row.taskId === adminTaskId || row.projectId === dealId
      || blob.includes(dealName) || blob.includes(memberTitle) || blob.includes(adminTitle);
  });
  expect(leaked, `${who.name} reminder rows`).toEqual([]);
  const items = await bell(who);
  const body = JSON.stringify(items);
  for (const needle of [dealName, memberTitle, adminTitle, dealId, `/projects/${dealId}`, `/tasks/${memberTaskId}`, `/tasks/${adminTaskId}`]) {
    expect(body, needle).not.toContain(needle);
  }
}

/** The row the job writes on main: task id, project id, and the task title, linked from the bell. */
async function expectDealReminder(who: Account, taskId: string, title: string) {
  const rows = (await dueRows(who.id)).filter((row) => row.taskId === taskId);
  expect(rows).toEqual([
    { recipientId: who.id, type: "TASK_DUE_TOMORROW", taskId, projectId: dealId, data: { title } },
  ]);
  const items = (await bell(who)).filter((item) => item.href === `/tasks/${taskId}`);
  expect(items.map((item) => item.text)).toEqual([`"${title}" is due tomorrow.`]);
}

async function expectOpsReminder(exact: boolean) {
  const rows = (await dueRows(member.id)).filter((row) => row.taskId === opsTaskId);
  expect(rows.length).toBeGreaterThanOrEqual(1);
  if (exact) expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({
    recipientId: member.id, type: "TASK_DUE_TOMORROW", taskId: opsTaskId, projectId: opsProjectId, data: { title: opsTitle },
  });
  const items = (await bell(member)).filter((item) => item.text === `"${opsTitle}" is due tomorrow.` && item.href === `/tasks/${opsTaskId}`);
  expect(items.length).toBeGreaterThanOrEqual(1);
  if (exact) expect(items).toHaveLength(1);
}

async function runMode(mode: Mode) {
  await clearReminders();
  await withMode(mode, async () => {
    if (mode === "unset") expect(crmMode()).toBe("all");
    else expect(crmMode()).toBe(mode);
    const result = await sendReminders();
    expect(result.sent).toBeGreaterThanOrEqual(1);
  });
}

describe("qa:TC missing APL-2729 AC1-AC3: reminder jobs apply crmProjectWhere in process", () => {
  beforeAll(async () => {
    assertLocalTestDatabase();
    const sa = await superAdmin();
    dealAdmin = await admin(sa, "zzdealadmin");
    member = await account("zzmember");
    const pipes = (await dealAdmin.c.get("/api/deals/pipelines")).json.pipelines as { id: string; key: string }[];
    const pipe = pipes.find((p) => p.key === "DEAL_PROACTIVE");
    expect(pipe?.id).toBeTruthy();
    const org = await dealAdmin.c.post("/api/orgs", { name: `ZZ-TEST Org ${tag}` });
    expect(org.status, JSON.stringify(org.json)).toBe(201);
    const made = await dealAdmin.c.post("/api/deals", {
      name: dealName,
      organisationId: org.json.organisation.id,
      pipelineId: pipe!.id,
      leaderId: dealAdmin.id,
      whyPursue: "ZZ-TEST fit",
      nextStep: { title: `ZZ-TEST later step ${tag}`, dueDate: istDate(14) },
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    dealId = made.json.deal.id as string;
    expect((await dealAdmin.c.post(`/api/projects/${dealId}/members`, { userId: member.id, role: "EDITOR" })).status).toBe(201);
    memberTaskId = await task(dealAdmin, dealId, { title: memberTitle, assigneeId: member.id, dueDate: istDate(1) });
    adminTaskId = await task(dealAdmin, dealId, { title: adminTitle, assigneeId: dealAdmin.id, dueDate: istDate(1) });
    const ops = await project(dealAdmin, dealAdmin, [{ who: member }]);
    opsProjectId = ops.id;
    opsTaskId = await task(dealAdmin, ops.id, { title: opsTitle, assigneeId: member.id, dueDate: istDate(1) });
  }, 60_000);

  afterAll(async () => {
    if (!member?.id) return;
    await db.notification.deleteMany({ where: { recipientId: { in: [member.id, dealAdmin.id] }, type: { in: [...DUE] } } });
  });

  it("qa:TC missing AC2 AC3: unset matches main for member, admin and the ops check", async () => {
    await runMode("unset");
    await expectDealReminder(member, memberTaskId, memberTitle);
    await expectDealReminder(dealAdmin, adminTaskId, adminTitle);
    await expectOpsReminder(true);
  });

  it("qa:TC missing AC2 AC3: CRM_VISIBLE=all matches main for member, admin and the ops check", async () => {
    await runMode("all");
    await expectDealReminder(member, memberTaskId, memberTitle);
    await expectDealReminder(dealAdmin, adminTaskId, adminTitle);
    await expectOpsReminder(true);
  });

  it("qa:TC missing AC1 AC2 AC3: admins gives a member no deal reminder, an admin the reminder as on main, and the ops check unchanged", async () => {
    await runMode("admins");
    await expectNoDealReminder(member);
    await expectDealReminder(dealAdmin, adminTaskId, adminTitle);
    await expectOpsReminder(true);
  });

  it("qa:TC missing AC1 AC3: off gives nobody a deal reminder and leaves the ops check unchanged", async () => {
    await runMode("off");
    await expectNoDealReminder(member);
    await expectNoDealReminder(dealAdmin);
    await expectOpsReminder(true);
  });

  it("qa:TC missing AC1 AC2 AC3: 40 concurrent reminder runs under admins name no hidden deal to the member", async () => {
    await clearReminders();
    await withMode("admins", async () => {
      const today = startOfTodayIST();
      const queries = await Promise.all(Array.from({ length: LOAD }, () => db.task.findMany({
        where: reminderTaskWhere(today),
        select: { id: true, title: true, projectId: true, assigneeId: true },
      })));
      expect(queries).toHaveLength(LOAD);
      for (const tasks of queries) {
        expect(tasks.some((row) => row.id === memberTaskId)).toBe(false);
        expect(tasks.some((row) => row.id === adminTaskId && row.projectId === dealId)).toBe(true);
        expect(tasks.some((row) => row.id === opsTaskId && row.projectId === opsProjectId)).toBe(true);
        const memberRows = JSON.stringify(tasks.filter((row) => row.assigneeId === member.id));
        expect(memberRows).not.toContain(dealName);
        expect(memberRows).not.toContain(memberTitle);
        expect(memberRows).not.toContain(dealId);
      }
      const results = await Promise.all(Array.from({ length: LOAD }, () => sendReminders()));
      expect(results).toHaveLength(LOAD);
      for (const result of results) expect(result.sent).toBeGreaterThanOrEqual(0);
    });
    await expectNoDealReminder(member);
    const adminRows = (await dueRows(dealAdmin.id)).filter((row) => row.taskId === adminTaskId);
    expect(adminRows.length).toBeGreaterThanOrEqual(1);
    expect(adminRows[0]).toMatchObject({ type: "TASK_DUE_TOMORROW", projectId: dealId, data: { title: adminTitle } });
    await expectOpsReminder(false);
  }, 90_000);
});
