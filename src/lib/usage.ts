// SHO-US-9.2 AC3 and 5.6 AC4: model usage for the Super Admin. Counts, tokens and money only;
// no chat text is ever stored in or read from here.
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import type { Actor } from "@/lib/access";
import { monthStartIST, nextMonthStartIST, weekStartIST } from "@/lib/concierge/dates";
import { monthlyCeilingUsd, weeklyMessageCap, WARN_AT } from "@/lib/concierge/limits";
import { QUICK_ACTIONS } from "@/lib/concierge/reads";

export async function usageSummary(user: Actor, now = new Date()) {
  if (user.orgRole !== "SUPER_ADMIN") throw new ApiError(404, "Resource not found");
  const monthStart = monthStartIST(now);
  const weekStart = weekStartIST(now);
  const modelCalls = { model: { not: { startsWith: "quick:" } } };
  const [month, monthMsgs, weekMsgs, byUser, quick] = await Promise.all([
    db.modelUsage.aggregate({ where: { createdAt: { gte: monthStart }, ...modelCalls }, _count: true, _sum: { inputTokens: true, outputTokens: true, costUsd: true } }),
    db.modelUsage.groupBy({ by: ["userId"], where: { createdAt: { gte: monthStart }, counted: true }, _count: true }),
    db.modelUsage.groupBy({ by: ["userId"], where: { createdAt: { gte: weekStart }, counted: true }, _count: true }),
    db.modelUsage.groupBy({ by: ["userId"], where: { createdAt: { gte: monthStart }, ...modelCalls }, _count: true, _sum: { costUsd: true } }),
    db.modelUsage.groupBy({ by: ["model"], where: { createdAt: { gte: monthStart }, model: { startsWith: "quick:" } }, _count: true }),
  ]);
  const ids = [...new Set([...weekMsgs.map((w) => w.userId), ...monthMsgs.map((w) => w.userId), ...byUser.map((b) => b.userId)])];
  const names = new Map((await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const weekBy = new Map(weekMsgs.map((w) => [w.userId, w._count]));
  const monthBy = new Map(monthMsgs.map((w) => [w.userId, w._count]));
  const costBy = new Map(byUser.map((b) => [b.userId, { calls: b._count, cost: Number(b._sum.costUsd ?? 0) }]));
  const spend = Number(month._sum.costUsd ?? 0);
  const ceiling = monthlyCeilingUsd();
  const quickBy = new Map(quick.map((x) => [x.model.slice("quick:".length), x._count]));
  return {
    monthStart: monthStart.toISOString(),
    weekStart: weekStart.toISOString(),
    resumesAt: nextMonthStartIST(now).toISOString(),
    ceiling: { usd: ceiling, spendUsd: spend, percent: Math.round((spend / ceiling) * 1000) / 10, warnAtPercent: WARN_AT * 100, weeklyMessageCap: weeklyMessageCap() },
    month: {
      calls: month._count, inputTokens: month._sum.inputTokens ?? 0, outputTokens: month._sum.outputTokens ?? 0, costUsd: spend,
      messages: [...monthBy.values()].reduce((a, b) => a + b, 0),
    },
    quickActions: QUICK_ACTIONS.map((q) => ({ id: q.id, label: q.label, count: quickBy.get(q.id) ?? 0 })),
    // weekCalls keeps its old name for the existing screen; it now counts messages sent (the number the weekly cap uses).
    people: ids.map((id) => ({
      id, name: names.get(id) ?? "Unknown",
      monthCalls: costBy.get(id)?.calls ?? 0, weekCalls: weekBy.get(id) ?? 0,
      monthMessages: monthBy.get(id) ?? 0, weekMessages: weekBy.get(id) ?? 0,
      monthCostUsd: costBy.get(id)?.cost ?? 0,
    })),
  };
}
