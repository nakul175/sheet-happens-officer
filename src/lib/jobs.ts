// Scheduled jobs (SHO-US-9.3 AC6). Each run is recorded in JobRun; a failure or a missed
// day puts a notice in every Super Admin's bell. Jobs are triggered by the server's cron
// through POST /api/jobs/<name> with the JOB_SECRET; nothing here is reachable from a session.
import { timingSafeEqual } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { OrgRole } from "@/lib/access";
import { db } from "@/lib/db";
import { purgeOld } from "@/lib/feed";
import { ApiError } from "@/lib/http";
import { notify } from "@/lib/notify";
import { notifyStalledDeals } from "@/lib/deals";
import { purgeTrash } from "@/lib/tasks";
import { startOfTodayIST } from "@/lib/dates";
import { purgeChat } from "@/lib/concierge/thread";
import { warnIfNearCeiling } from "@/lib/concierge/limits";
import { crmMode, crmProjectWhere } from "@/lib/crm";

type Job = { name: string; about: string; run: (now?: Date) => Promise<unknown> };

export const JOBS: Job[] = [
  { name: "purge-trash", about: "Removes tasks that have been in Trash for more than 30 days, and soft-deleted comments once they are older than 30 days", run: () => purgeTrash() },
  { name: "purge-old", about: "Removes notifications after 90 days, action and audit logs after 12 months, and soft-deleted comments once they are older than 30 days", run: () => purgeOld() },
  { name: "purge-chat", about: "Deletes concierge chat messages after 90 days", run: () => purgeChat() },
  { name: "concierge-budget", about: "Tells the Super Admin once a month when concierge spend reaches 80 percent of the ceiling", run: async () => ({ warned: await warnIfNearCeiling() }) },
  { name: "reminders", about: "Due-tomorrow, due-today and overdue reminders to the holder of each open task, 8:00 am India time", run: () => sendReminders() },
  { name: "stalled-deals", about: "Tells the Leader of each deal with no activity for 30 days, once per stall, 7:50 am India time", run: (now) => notifyStalledDeals(now) },
  { name: "check", about: "Tells the Super Admin when a job failed or did not run", run: () => checkJobs() },
];
const DAILY_GRACE_HOURS = 30;

const DAY_MS = 86400_000;
/** Which reminder, if any, a task due `due` gets on the day starting at `today` (SHO-US-7.4). */
export function reminderFor(due: Date, today: Date): { type: "TASK_DUE_TOMORROW" | "TASK_DUE_TODAY" | "TASK_OVERDUE"; daysOverdue?: number } | null {
  const diff = Math.round((due.getTime() - today.getTime()) / DAY_MS);
  if (diff === 1) return { type: "TASK_DUE_TOMORROW" };
  if (diff === 0) return { type: "TASK_DUE_TODAY" };
  const late = -diff;
  // First overdue day, then once a week, nothing after 4 weeks overdue.
  if (late >= 1 && late <= 28 && (late - 1) % 7 === 0) return { type: "TASK_OVERDUE", daysOverdue: late };
  return null;
}

/**
 * Which open tasks may produce a reminder.
 * `crmProjectWhere` is applied for the assignee: under `all` and unset it is empty, so this matches
 * the previous project filter. Under `off` a deal is left out for every assignee. Under `admins` a
 * deal is left out unless the assignee is an Admin or the Super Admin (APL-2729).
 */
export function reminderTaskWhere(today: Date): Prisma.TaskWhereInput {
  const dueDate = { gte: new Date(today.getTime() - 28 * DAY_MS), lte: new Date(today.getTime() + DAY_MS) };
  const open = { completedAt: null, deletedAt: null, blocked: false, dueDate };
  // AND keeps `archivedAt` if a later crmProjectWhere returns its own archivedAt or OR.
  const projectFor = (role: OrgRole): Prisma.ProjectWhereInput => ({
    AND: [{ archivedAt: null }, crmProjectWhere({ orgRole: role })],
  });
  const mode = crmMode();
  if (mode !== "admins") {
    // off hides deals from every role, including the Super Admin. all (and unset) hides them from nobody.
    return { ...open, project: projectFor(mode === "off" ? "SUPER_ADMIN" : "MEMBER") };
  }
  return {
    ...open,
    OR: [
      { project: projectFor("MEMBER") },
      // Named roles only. A future role must not receive deal reminders merely by not being a Member.
      { project: projectFor("ADMIN"), assignee: { orgRole: { in: ["ADMIN", "SUPER_ADMIN"] } } },
    ],
  };
}

/** pg_advisory_xact_lock key for sendReminders. Distinct from the concierge budget key (4120801). */
const REMINDERS_LOCK_KEY = 2749001;

/** Holder = the assignee; while a task awaits approval the approver is the assignee (SHO-US-4.6). */
export async function sendReminders(now = new Date()) {
  const today = startOfTodayIST(now);
  const tasks = await db.task.findMany({
    where: reminderTaskWhere(today),
    select: { id: true, title: true, projectId: true, assigneeId: true, dueDate: true, assignee: { select: { deactivatedAt: true } } },
  });
  // One transaction under an advisory lock: two overlapping runs cannot both find "not sent yet" (APL-2749).
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${REMINDERS_LOCK_KEY})`;
    const already = await tx.notification.findMany({
      where: { type: { in: ["TASK_DUE_TOMORROW", "TASK_DUE_TODAY", "TASK_OVERDUE"] }, createdAt: { gte: today } },
      select: { taskId: true, type: true },
    });
    const done = new Set(already.map((n) => `${n.taskId}|${n.type}`));
    const rows: { recipientId: string; type: string; taskId: string; projectId: string; data: { title: string; daysOverdue?: number } }[] = [];
    for (const t of tasks) {
      if (t.assignee.deactivatedAt || !t.dueDate) continue;
      const r = reminderFor(t.dueDate, today);
      if (!r || done.has(`${t.id}|${r.type}`)) continue;
      rows.push({ recipientId: t.assigneeId, type: r.type, taskId: t.id, projectId: t.projectId, data: { title: t.title, ...(r.daysOverdue ? { daysOverdue: r.daysOverdue } : {}) } });
    }
    if (rows.length) await tx.notification.createMany({ data: rows });
    return { sent: rows.length };
  });
}

export function requireJobSecret(req: Request) {
  const secret = process.env.JOB_SECRET ?? "";
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const ok = secret.length >= 16 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) throw new ApiError(401, "Not allowed");
}

export async function runJob(name: string, now?: Date) {
  const job = JOBS.find((j) => j.name === name);
  if (!job) throw new ApiError(404, "No such job");
  const started = new Date();
  await db.jobRun.upsert({ where: { job: name }, create: { job: name, lastStartedAt: started }, update: { lastStartedAt: started } });
  try {
    const result = await job.run(now);
    await db.jobRun.update({ where: { job: name }, data: { lastFinishedAt: new Date(), lastStatus: "OK", lastError: null } });
    return { job: name, status: "OK", result };
  } catch (err) {
    const error = String((err as Error)?.message ?? err).slice(0, 500);
    await db.jobRun.update({ where: { job: name }, data: { lastFinishedAt: new Date(), lastStatus: "FAILED", lastError: error } });
    await tellSuperAdmins("JOB_FAILED", name, error);
    throw new ApiError(500, `Job ${name} failed: ${error}`);
  }
}

/** One notice per job per day, to every active Super Admin. */
async function tellSuperAdmins(type: "JOB_FAILED" | "JOB_MISSED", job: string, error?: string | null) {
  const since = new Date(Date.now() - 20 * 3600_000);
  const already = await db.notification.findFirst({ where: { type, createdAt: { gte: since }, data: { path: ["job"], equals: job } } });
  if (already) return;
  const admins = await db.user.findMany({ where: { orgRole: "SUPER_ADMIN", deactivatedAt: null }, select: { id: true } });
  // Inside a transaction, as every other caller: notify() dedupes per client, and the process-wide `db` client
  // would make every job notice after the first one per Super Admin vanish until a restart (SHO-BUG-1).
  await db.$transaction((tx) => notify(tx, admins.map((a) => a.id), type, { data: { job, error: error ?? null } }));
}

export async function jobStatus() {
  const runs = await db.jobRun.findMany();
  return JOBS.map((j) => {
    const r = runs.find((x) => x.job === j.name);
    return { job: j.name, about: j.about, lastStartedAt: r?.lastStartedAt ?? null, lastFinishedAt: r?.lastFinishedAt ?? null, lastStatus: r?.lastStatus ?? null, lastError: r?.lastError ?? null };
  });
}

/** Daily: a job that failed, or has not finished in the last 30 hours, is reported. */
export async function checkJobs() {
  const cutoff = new Date(Date.now() - DAILY_GRACE_HOURS * 3600_000);
  const problems: string[] = [];
  for (const s of await jobStatus()) {
    if (s.job === "check") continue;
    if (s.lastStatus === "FAILED") { problems.push(`${s.job}: failed`); await tellSuperAdmins("JOB_FAILED", s.job, s.lastError); }
    else if (!s.lastFinishedAt || s.lastFinishedAt < cutoff) { problems.push(`${s.job}: not run`); await tellSuperAdmins("JOB_MISSED", s.job); }
  }
  return { problems };
}
