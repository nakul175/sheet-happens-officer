// Scheduled jobs (SHO-US-9.3 AC6). Each run is recorded in JobRun; a failure or a missed
// day puts a notice in every Super Admin's bell. Jobs are triggered by the server's cron
// through POST /api/jobs/<name> with the JOB_SECRET; nothing here is reachable from a session.
import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import { purgeOld } from "@/lib/feed";
import { ApiError } from "@/lib/http";
import { notify } from "@/lib/notify";
import { purgeTrash } from "@/lib/tasks";

type Job = { name: string; about: string; run: () => Promise<unknown> };

export const JOBS: Job[] = [
  { name: "purge-trash", about: "Removes tasks that have been in Trash for 30 days", run: () => purgeTrash() },
  { name: "purge-old", about: "Removes notifications after 90 days and action and audit logs after 12 months", run: () => purgeOld() },
  { name: "check", about: "Tells the Super Admin when a job failed or did not run", run: () => checkJobs() },
];
const DAILY_GRACE_HOURS = 30;

export function requireJobSecret(req: Request) {
  const secret = process.env.JOB_SECRET ?? "";
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const ok = secret.length >= 16 && given.length === secret.length && timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) throw new ApiError(401, "Not allowed");
}

export async function runJob(name: string) {
  const job = JOBS.find((j) => j.name === name);
  if (!job) throw new ApiError(404, "No such job");
  const started = new Date();
  await db.jobRun.upsert({ where: { job: name }, create: { job: name, lastStartedAt: started }, update: { lastStartedAt: started } });
  try {
    const result = await job.run();
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
  await notify(db, admins.map((a) => a.id), type, { data: { job, error: error ?? null } });
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
