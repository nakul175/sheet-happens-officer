// SHO-US-9.2 AC3 and 5.6 AC4: model usage for the Super Admin. Counts, tokens and cost only;
// no chat text is ever stored in or read from here. Empty until the concierge ships.
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { startOfTodayIST } from "@/lib/dates";
import type { Actor } from "@/lib/access";

export async function usageSummary(user: Actor) {
  if (user.orgRole !== "SUPER_ADMIN") throw new ApiError(404, "Resource not found");
  const today = startOfTodayIST();
  const ist = new Date(today.getTime() + 5.5 * 3600_000);
  const monthStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 5.5 * 3600_000);
  // Weeks start on Monday, India time.
  const weekStart = new Date(today.getTime() - ((ist.getUTCDay() + 6) % 7) * 86400_000);
  const [month, week, byUser] = await Promise.all([
    db.modelUsage.aggregate({ where: { createdAt: { gte: monthStart } }, _count: true, _sum: { inputTokens: true, outputTokens: true, costUsd: true } }),
    db.modelUsage.groupBy({ by: ["userId"], where: { createdAt: { gte: weekStart } }, _count: true }),
    db.modelUsage.groupBy({ by: ["userId"], where: { createdAt: { gte: monthStart } }, _count: true, _sum: { costUsd: true } }),
  ]);
  const ids = [...new Set([...week.map((w) => w.userId), ...byUser.map((b) => b.userId)])];
  const names = new Map((await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const weekBy = new Map(week.map((w) => [w.userId, w._count]));
  return {
    monthStart: monthStart.toISOString(),
    weekStart: weekStart.toISOString(),
    month: { calls: month._count, inputTokens: month._sum.inputTokens ?? 0, outputTokens: month._sum.outputTokens ?? 0, costUsd: Number(month._sum.costUsd ?? 0) },
    people: byUser.map((b) => ({ id: b.userId, name: names.get(b.userId) ?? "Unknown", monthCalls: b._count, weekCalls: weekBy.get(b.userId) ?? 0, monthCostUsd: Number(b._sum.costUsd ?? 0) })),
  };
}
