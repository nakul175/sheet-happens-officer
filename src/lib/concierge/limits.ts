// SHO-US-9.2: usage ledger, caps and the 80 percent warning. Counts and money only; no text.
import { db } from "@/lib/db";
import { notify } from "@/lib/notify";
import { modelConfig, modelEnabled } from "@/lib/model";
import { fullDate, monthStartIST, nextMonthStartIST, nextWeekStartIST, weekStartIST } from "@/lib/concierge/dates";

export type DisabledCode = "NOT_ENABLED" | "MONTH_CAP" | "WEEK_CAP" | "PROVIDER_DOWN";
export type Disabled = { code: DisabledCode; message: string; resumesAt?: string };

const numEnv = (v: string | undefined, d: number) => {
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};
export const monthlyCeilingUsd = () => numEnv(process.env.MONTHLY_CEILING_USD, 100);
export const weeklyMessageCap = () => Math.floor(numEnv(process.env.WEEKLY_MESSAGE_CAP, 200));
export const WARN_AT = 0.8;

export async function monthSpendUsd(now = new Date()) {
  const r = await db.modelUsage.aggregate({ where: { createdAt: { gte: monthStartIST(now), lt: nextMonthStartIST(now) } }, _sum: { costUsd: true } });
  return Number(r._sum.costUsd ?? 0);
}
export async function weekMessages(userId: string, now = new Date()) {
  return db.modelUsage.count({ where: { userId, counted: true, createdAt: { gte: weekStartIST(now), lt: nextWeekStartIST(now) } } });
}

// A provider that failed twice in a row is treated as down for a short while, so every message does not wait 2 seconds.
let downUntil = 0;
const DOWN_MS = 60_000;
export const markProviderDown = (now = Date.now()) => { downUntil = now + DOWN_MS; };
export const clearProviderDown = () => { downUntil = 0; };
export const providerDownUntil = (now = Date.now()) => (downUntil > now ? new Date(downUntil) : null);

export const notEnabled = (): Disabled => ({ code: "NOT_ENABLED", message: "The concierge is not switched on yet." });
export const providerDown = (until: Date): Disabled => ({
  code: "PROVIDER_DOWN",
  message: "The concierge cannot reach its language service right now. The rest of the app works normally; try again in a minute.",
  resumesAt: until.toISOString(),
});

/** Why the concierge cannot answer this person right now, or null. Order: switch, month, week, provider. */
export async function disabledFor(userId: string, now = new Date()): Promise<Disabled | null> {
  if (!modelEnabled(modelConfig())) return notEnabled();
  const month = await monthCap(now);
  if (month) return month;
  const used = await weekMessages(userId, now);
  if (used >= weeklyMessageCap()) {
    const resumes = nextWeekStartIST(now);
    return { code: "WEEK_CAP", message: `You have used your ${weeklyMessageCap()} concierge messages for this week. The count resets on ${fullDate(resumes)} at 12:00 am India time. Quick actions still work.`, resumesAt: resumes.toISOString() };
  }
  const down = providerDownUntil(now.getTime());
  if (down) return providerDown(down);
  return null;
}

/** Writes one ledger row. `counted` marks the first call of a message the person sent. */
export async function recordUsage(userId: string, r: { model: string; usage: { input: number; output: number; cacheWrite: number; cacheRead: number }; costUsd: number }, counted: boolean) {
  await db.modelUsage.create({
    data: {
      userId, model: r.model, counted,
      inputTokens: r.usage.input + r.usage.cacheWrite + r.usage.cacheRead,
      outputTokens: r.usage.output,
      costUsd: r.costUsd.toFixed(6),
    },
  });
  await warnIfNearCeiling();
}

/** A quick action: a ledger row with no tokens and no cost, so Usage can count it. Never counted against the person. */
export async function recordQuickAction(userId: string, id: string) {
  await db.modelUsage.create({ data: { userId, model: `quick:${id}`, inputTokens: 0, outputTokens: 0, costUsd: "0", counted: false } });
}

/** One bell notice per calendar month to every active Super Admin when spend reaches 80 percent of the ceiling (AC4). */
export async function warnIfNearCeiling(now = new Date()) {
  const ceiling = monthlyCeilingUsd();
  const spend = await monthSpendUsd(now);
  if (spend < ceiling * WARN_AT) return false;
  const monthStart = monthStartIST(now);
  const already = await db.notification.findFirst({ where: { type: "CONCIERGE_BUDGET_80", createdAt: { gte: monthStart } } });
  if (already) return false;
  const admins = await db.user.findMany({ where: { orgRole: "SUPER_ADMIN", deactivatedAt: null }, select: { id: true } });
  if (!admins.length) return false;
  await notify(db, admins.map((a) => a.id), "CONCIERGE_BUDGET_80", {
    data: { spend: Math.round(spend * 100) / 100, ceiling, percent: Math.round((spend / ceiling) * 100), resumes: fullDate(nextMonthStartIST(now)) },
  });
  return true;
}

/** Checked before every model call inside a message: only the month can stop a message half way. */
export async function monthCap(now = new Date()): Promise<Disabled | null> {
  if ((await monthSpendUsd(now)) < monthlyCeilingUsd()) return null;
  const resumes = nextMonthStartIST(now);
  return { code: "MONTH_CAP", message: `The concierge is paused for the rest of this month. It resumes on ${fullDate(resumes)}. Screens and quick actions keep working.`, resumesAt: resumes.toISOString() };
}
