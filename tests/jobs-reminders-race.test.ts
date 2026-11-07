// APL-2749. Overlapping reminder job runs (a cron retry, or a manual POST during the scheduled run)
// must not write the same due-date reminder twice. Everything goes through the shared test server:
// people, project and tasks are made through the API, the job is POSTed with JOB_SECRET, and the
// reminders are read back on GET /api/notifications. Names are ZZ-TEST, addresses nakul17+ aliases.
// 40 concurrent POSTs alone did not overlap on a local `next start` (each run takes a few ms), so the AC1
// test adds one hook, inside the test only: a separate connection holds a SHARE lock on "Notification"
// (no rows written) while the runs start. Reads go through; each run's insert waits on the lock. The lock
// is released as soon as a second connection sees in pg_stat_activity two runs waiting past their read: two inserts waiting (the bug),
// or one insert plus one run waiting on the reminders advisory lock (the fix).
// The CRM_VISIBLE filter (AC3) is covered unchanged by tests/jobs-reminders-crm.test.ts and
// tests/jobs-reminders-crm-server.mode.test.ts (`npm run test:modes`).
//
// qa:TC missing single run
// qa:TC missing 40 concurrent reminder requests
import pg from "pg";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE, OUTBOX, istDate, task, type Account } from "./helpers";
import { zzTestData, type ZzProject } from "./zz-test-data";

const LOAD = 40;
/** Longest the test holds the lock: well under Prisma's default 2 s maxWait / 5 s timeout, which the fix keeps. */
const MAX_HOLD_MS = 500;
const tag = `${Date.now().toString(36)}-${process.pid}`;
const zz = zzTestData("2749");

type BellItem = { text: string; href: string | null };

let leader: Account;
let holder: Account;
let proj: ZzProject;

/** The local test database, without Prisma's ?schema= parameter. Anything else is refused. */
function localDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required and must point at the local test database");
  const url = new URL(raw);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1" && url.hostname !== "[::1]") {
    throw new Error("Refusing to run: the reminder race test uses the local test database only");
  }
  url.search = "";
  return url.toString();
}

/** Waits until two runs are past their read: two inserts on the lock, or one insert and one advisory-lock wait. */
async function waitForOverlap(watch: pg.Client, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await watch.query<{ inserts: number; advisory: number }>(
      `SELECT count(*) FILTER (WHERE query ILIKE 'INSERT INTO %"Notification"%')::int AS inserts,
              count(*) FILTER (WHERE wait_event = 'advisory')::int AS advisory
       FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active' AND wait_event_type = 'Lock'`,
    );
    const { inserts, advisory } = rows[0];
    if (inserts >= 2 || (inserts >= 1 && advisory >= 1)) return { inserts, advisory };
    await new Promise((r) => setTimeout(r, 5));
  }
  return null;
}

async function postReminders(count: number) {
  const secret = process.env.JOB_SECRET ?? "";
  expect(secret.length, "JOB_SECRET (the shared test server's job token) is required").toBeGreaterThanOrEqual(16);
  const responses = await Promise.all(Array.from({ length: count }, () => fetch(`${BASE}/api/jobs/reminders`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` },
  })));
  for (const res of responses) {
    const text = await res.text();
    expect(res.status, text.replaceAll(secret, "[redacted]").slice(0, 180)).toBe(200);
    expect((JSON.parse(text) as { status?: string }).status).toBe("OK");
  }
}

/** Bell items that are the due-tomorrow reminder for this task. */
async function dueTomorrow(who: Account, taskId: string, title: string) {
  const r = await who.c.get("/api/notifications?limit=200");
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return (r.json.items as BellItem[]).filter((item) => item.href === `/tasks/${taskId}` && item.text === `"${title}" is due tomorrow.`);
}

async function dueReminderRecipients(taskId: string) {
  const client = new pg.Client({ connectionString: localDatabaseUrl(), statement_timeout: 5_000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ recipientId: string }>(
      'SELECT "recipientId" FROM "Notification" WHERE "taskId" = $1 AND "type" = $2',
      [taskId, "TASK_DUE_TOMORROW"],
    );
    return rows.map((row) => row.recipientId);
  } finally {
    await client.end();
  }
}

async function dueReminderRows(taskId: string) {
  const client = new pg.Client({ connectionString: localDatabaseUrl(), statement_timeout: 5_000 });
  try {
    await client.connect();
    const { rows } = await client.query<{ recipientId: string; type: string }>(
      'SELECT "recipientId", "type" FROM "Notification" WHERE "taskId" = $1 AND "type" IN ($2, $3, $4)',
      [taskId, "TASK_DUE_TOMORROW", "TASK_DUE_TODAY", "TASK_OVERDUE"],
    );
    return rows;
  } finally {
    await client.end();
  }
}

async function taskAndMembership(taskId: string, projectId: string, userId: string) {
  const client = new pg.Client({ connectionString: localDatabaseUrl(), statement_timeout: 5_000 });
  try {
    await client.connect();
    const task = await client.query<{ assigneeId: string; deletedAt: Date | null }>(
      'SELECT "assigneeId", "deletedAt" FROM "Task" WHERE "id" = $1', [taskId],
    );
    const member = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "ProjectMember" WHERE "projectId" = $1 AND "userId" = $2',
      [projectId, userId],
    );
    return { task: task.rows[0], memberCount: member.rows[0].count };
  } finally {
    await client.end();
  }
}

/** One task due tomorrow for each holder, so each run starts with no reminder written for them. */
async function dueTasks(label: string) {
  const holderTitle = `ZZ-TEST ${label} ${tag}`;
  const leaderTitle = `ZZ-TEST ${label} ${tag} leader`;
  const holderTaskId = await task(leader, proj.id, { title: holderTitle, assigneeId: holder.id, dueDate: istDate(1) });
  const leaderTaskId = await task(leader, proj.id, { title: leaderTitle, assigneeId: leader.id, dueDate: istDate(1) });
  return [
    { who: holder, taskId: holderTaskId, title: holderTitle },
    { who: leader, taskId: leaderTaskId, title: leaderTitle },
  ];
}

type EligibilityChange = "reassign" | "archive" | "deactivate";

/** Commit a competing eligibility change while a reminder job waits on its row/insert. */
async function raceEligibilityChange(change: EligibilityChange, taskId: string) {
  const gate = new pg.Client({ connectionString: localDatabaseUrl(), statement_timeout: 5_000, lock_timeout: 2_000 });
  const watch = new pg.Client({ connectionString: localDatabaseUrl(), statement_timeout: 5_000, lock_timeout: 2_000 });
  let began = false;
  let changed = false;
  let posts: Promise<unknown> | null = null;
  try {
    await gate.connect();
    await watch.connect();
    await gate.query("BEGIN");
    began = true;
    const row = change === "archive" ? { table: "Project", id: proj.id }
      : change === "deactivate" ? { table: "User", id: holder.id }
        : { table: "Task", id: taskId };
    // The relation name comes only from the fixed union above, never external input.
    await gate.query(`SELECT "id" FROM "${row.table}" WHERE "id" = $1 FOR UPDATE`, [row.id]);
    await gate.query('LOCK TABLE "Notification" IN SHARE MODE');
    posts = postReminders(1).then(() => null, (err: unknown) => err);
    const deadline = Date.now() + 3_000;
    let waiting = false;
    while (Date.now() < deadline) {
      const { rows } = await watch.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND state = 'active' AND wait_event_type = 'Lock'
           AND (query ILIKE '%"Task"%' OR query ILIKE '%"Project"%'
             OR query ILIKE '%"User"%' OR query ILIKE '%"Notification"%')`,
      );
      if (rows[0].count > 0) { waiting = true; break; }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(waiting, `reminder job reached the held ${row.table} row or notification insert`).toBe(true);
    if (change === "reassign") await gate.query('UPDATE "Task" SET "assigneeId" = $2 WHERE "id" = $1', [taskId, leader.id]);
    if (change === "archive") await gate.query('UPDATE "Project" SET "archivedAt" = $2 WHERE "id" = $1', [proj.id, new Date()]);
    if (change === "deactivate") await gate.query('UPDATE "User" SET "deactivatedAt" = $2 WHERE "id" = $1', [holder.id, new Date()]);
    await gate.query("COMMIT");
    began = false;
    changed = true;
    const failed = await posts;
    if (failed) throw failed;
    if (change === "archive") { await gate.query('UPDATE "Project" SET "archivedAt" = NULL WHERE "id" = $1', [proj.id]); changed = false; }
    if (change === "deactivate") { await gate.query('UPDATE "User" SET "deactivatedAt" = NULL WHERE "id" = $1', [holder.id]); changed = false; }
    const oldHolder = await dueTomorrow(holder, taskId, `ZZ-TEST ${change} during reminder ${tag}`);
    const newHolder = change === "reassign" ? await dueTomorrow(leader, taskId, `ZZ-TEST ${change} during reminder ${tag}`) : [];
    return { oldHolder, newHolder };
  } finally {
    try {
      if (began) await gate.query("ROLLBACK");
      // The change is part of the disposable fixture, not a permanent deactivation or archive.
      if (changed && change === "archive") await gate.query('UPDATE "Project" SET "archivedAt" = NULL WHERE "id" = $1', [proj.id]);
      if (changed && change === "deactivate") await gate.query('UPDATE "User" SET "deactivatedAt" = NULL WHERE "id" = $1', [holder.id]);
    } finally {
      await Promise.allSettled([gate.end(), watch.end()]);
    }
  }
}

describe("qa:TC missing APL-2749: overlapping reminder runs write one reminder per holder, task, type and day", () => {
  beforeAll(async () => {
    leader = await zz.person("Leader");
    holder = await zz.person("Holder");
    proj = await zz.project(leader);
    const added = await leader.c.post(`/api/projects/${proj.id}/members`, { userId: holder.id, role: "EDITOR" });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
  }, 60_000);

  afterAll(async () => {
    const problems = await zz.cleanUp();
    expect(problems, problems.join("\n")).toEqual([]);
  }, 60_000);

  it("qa:TC missing AC2: a single run writes the due-tomorrow reminder for each holder, linked to the task", async () => {
    const due = await dueTasks("single run");
    await postReminders(1);
    for (const d of due) {
      const items = await dueTomorrow(d.who, d.taskId, d.title);
      expect(items.map((item) => item.text)).toEqual([`"${d.title}" is due tomorrow.`]);
    }
  });

  it("qa:TC missing AC1: 40 concurrent POST /api/jobs/reminders leave exactly one reminder per holder and task", async () => {
    const due = await dueTasks("concurrent run");
    // The gate holds the lock; the watcher reads pg_stat_activity outside the gate's transaction snapshot.
    // Both are bounded: no statement runs past 5 s and no lock wait past 2 s, even if the release below never ran.
    const gate = new pg.Client({ connectionString: localDatabaseUrl(), statement_timeout: 5_000, lock_timeout: 2_000 });
    const watch = new pg.Client({ connectionString: localDatabaseUrl(), statement_timeout: 5_000, lock_timeout: 2_000 });
    let overlap: { inserts: number; advisory: number } | null = null;
    let posts: Promise<unknown>;
    let heldMs = 0;
    let began = false;
    try {
      await gate.connect();
      await watch.connect();
      for (const client of [gate, watch]) {
        const { rows } = await client.query<{ statement_timeout: string; lock_timeout: string }>(
          "SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout",
        );
        expect(rows[0]).toEqual({ statement_timeout: "5s", lock_timeout: "2s" });
      }
      await gate.query("BEGIN");
      began = true;
      await gate.query('LOCK TABLE "Notification" IN SHARE MODE');
      posts = postReminders(LOAD).then(() => null, (err: unknown) => err);
      const held = Date.now();
      overlap = await waitForOverlap(watch, MAX_HOLD_MS);
      heldMs = Date.now() - held;
    } finally {
      // APL-2894: end both clients even when a connect, the setting assert or the lock fails.
      try {
        if (began) await gate.query("ROLLBACK");
      } finally {
        await Promise.allSettled([gate.end(), watch.end()]);
      }
    }
    const failed = await posts;
    if (failed) throw failed;
    expect(overlap, "two reminder runs were waiting past their read at the same time").not.toBeNull();
    const counts: Record<string, number> = {};
    for (const d of due) counts[d.who === holder ? "holder" : "leader"] = (await dueTomorrow(d.who, d.taskId, d.title)).length;
    console.log(`APL-2749 overlap ${JSON.stringify(overlap)} after ${heldMs} ms held; reminder rows per (recipient, task, TASK_DUE_TOMORROW) after ${LOAD} concurrent runs: ${JSON.stringify(counts)}`);
    expect(counts).toEqual({ holder: 1, leader: 1 });
  }, 90_000);

  it("does not notify a task completed while a reminder run is waiting to insert", async () => {
    const title = `ZZ-TEST completed during reminder ${tag}`;
    const taskId = await task(leader, proj.id, { title, assigneeId: holder.id, dueDate: istDate(1) });
    const gate = new pg.Client({ connectionString: localDatabaseUrl(), statement_timeout: 5_000, lock_timeout: 2_000 });
    const watch = new pg.Client({ connectionString: localDatabaseUrl(), statement_timeout: 5_000, lock_timeout: 2_000 });
    let began = false;
    let posts: Promise<unknown> | null = null;
    try {
      await gate.connect();
      await watch.connect();
      await gate.query("BEGIN");
      began = true;
      // A completed task must never acquire a stale due notice. The row lock keeps the
      // completion before a fresh locked selection; the table lock exposes an old
      // pre-transaction selection by pausing its later notification insert.
      await gate.query('SELECT id FROM "Task" WHERE id = $1 FOR UPDATE', [taskId]);
      await gate.query('LOCK TABLE "Notification" IN SHARE MODE');
      posts = postReminders(1).then(() => null, (err: unknown) => err);
      const deadline = Date.now() + 3_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const { rows } = await watch.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity
           WHERE datname = current_database() AND pid <> pg_backend_pid()
             AND state = 'active' AND wait_event_type = 'Lock'
             AND (query ILIKE '%"Task"%' OR query ILIKE '%"Notification"%')`,
        );
        if (rows[0].count > 0) { waiting = true; break; }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(waiting, "reminder job reached the held task row or notification insert").toBe(true);
      await gate.query('UPDATE "Task" SET "completedAt" = $2 WHERE id = $1', [taskId, new Date()]);
      await gate.query("COMMIT");
      began = false;
    } finally {
      try { if (began) await gate.query("ROLLBACK"); }
      finally { await Promise.allSettled([gate.end(), watch.end()]); }
    }
    const failed = await posts;
    if (failed) throw failed;
    expect(await dueTomorrow(holder, taskId, title)).toEqual([]);
  }, 60_000);

  it.each(["reassign", "archive", "deactivate"] as const)(
    "rechecks task eligibility after a concurrent %s",
    async (change) => {
      const title = `ZZ-TEST ${change} during reminder ${tag}`;
      const taskId = await task(leader, proj.id, { title, assigneeId: holder.id, dueDate: istDate(1) });
      const { oldHolder, newHolder } = await raceEligibilityChange(change, taskId);
      expect(oldHolder, "former holder must not receive a stale due notice").toEqual([]);
      expect(newHolder.map((item) => item.text)).toEqual(change === "reassign" ? [`"${title}" is due tomorrow.`] : []);
    },
    60_000,
  );

  it("routes the next reminder only to the handover recipient after project membership removal", async () => {
    const separate = await zz.project(leader);
    const added = await leader.c.post(`/api/projects/${separate.id}/members`, { userId: holder.id, role: "EDITOR" });
    expect(added.status, JSON.stringify(added.json)).toBe(201);
    const title = `ZZ-TEST removed member reminder ${tag}`;
    const taskId = await task(leader, separate.id, { title, assigneeId: holder.id, dueDate: istDate(1) });
    const removed = await leader.c.del(`/api/projects/${separate.id}/members/${holder.id}?handoverTo=${leader.id}`);
    expect(removed.status, JSON.stringify(removed.json)).toBe(204);
    expect(await taskAndMembership(taskId, separate.id, holder.id)).toMatchObject({
      task: { assigneeId: leader.id, deletedAt: null }, memberCount: 0,
    });
    await postReminders(1);
    expect(await dueTomorrow(holder, taskId, title)).toEqual([]);
    expect(await dueTomorrow(leader, taskId, title)).toHaveLength(1);
    expect(await dueReminderRecipients(taskId)).toEqual([leader.id]);
  }, 60_000);

  it("leaves no due reminder for a task deleted before the job runs", async () => {
    const title = `ZZ-TEST deleted before reminder ${tag}`;
    const taskId = await task(leader, proj.id, { title, assigneeId: holder.id, dueDate: istDate(1) });
    const deleted = await leader.c.del(`/api/tasks/${taskId}`);
    expect(deleted.status, JSON.stringify(deleted.json)).toBe(204);
    expect((await taskAndMembership(taskId, proj.id, holder.id)).task.deletedAt).not.toBeNull();
    await postReminders(1);
    expect(await dueTomorrow(holder, taskId, title)).toEqual([]);
    expect(await dueReminderRecipients(taskId)).toEqual([]);
  }, 60_000);

  it("honors due-day boundaries, dedupes a second run, and sends no task email", async () => {
    const cases = [
      { offset: 1, type: "TASK_DUE_TOMORROW" },
      { offset: 0, type: "TASK_DUE_TODAY" },
      { offset: -1, type: "TASK_OVERDUE" },
      { offset: -8, type: "TASK_OVERDUE" },
      { offset: -29, type: null },
    ] as const;
    const due: { id: string; type: string | null }[] = [];
    for (const { offset, type } of cases) {
      due.push({ id: await task(leader, proj.id, {
        title: `ZZ-TEST reminder boundary ${offset} ${tag}`,
        assigneeId: holder.id,
        dueDate: istDate(offset),
      }), type });
    }
    await postReminders(1);
    await postReminders(1);
    for (const { id, type } of due) {
      const rows = await dueReminderRows(id);
      expect(rows, `due reminder for ${id}`).toEqual(type ? [{ recipientId: holder.id, type }] : []);
    }
    const mailFiles = (() => { try { return readdirSync(OUTBOX); } catch { return []; } })();
    const mail = mailFiles.map((file) => readFileSync(path.join(OUTBOX, file), "utf8")).join("\n");
    expect(mail).not.toContain(`ZZ-TEST reminder boundary 1 ${tag}`);
    expect(mail).not.toContain(`ZZ-TEST reminder boundary 0 ${tag}`);
    expect(mail).not.toContain(`ZZ-TEST reminder boundary -1 ${tag}`);
    expect(mail).not.toContain(`ZZ-TEST reminder boundary -8 ${tag}`);
  }, 60_000);
});
