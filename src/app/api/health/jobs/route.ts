import { connection } from "next/server";
import { db } from "@/lib/db";

// Is the server's cron alive? The 'check' job runs daily; if it has not finished in 36 hours
// the cron is not running and nobody would be told (SHO-US-9.3 AC6). 503 when stale so an
// external uptime check or ops-checks.yml can alert on it. Never run yet: 200, waiting for the first run.
const STALE_HOURS = 36;
export async function GET() {
  await connection();
  try {
    const r = await db.jobRun.findUnique({ where: { job: "check" } });
    const last = r?.lastFinishedAt ?? null;
    const ageHours = last ? (Date.now() - last.getTime()) / 3600_000 : null;
    const stale = ageHours !== null && ageHours > STALE_HOURS;
    return Response.json({ ok: !stale, lastCheck: last, ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10 }, { status: stale ? 503 : 200, headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
