// APL-2641 AC3: on the 1st of a month (India time) the Usage figures start at zero.
// Quick actions stay out of the message total (AC2). The screen prints whatever /api/usage returns.
import { afterAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "@/lib/db";
import { usageSummary } from "@/lib/usage";
import { QUICK_ACTIONS } from "@/lib/concierge/reads";
import { UsageContents } from "@/app/(app)/usage/screen";
import { istInstant } from "./concierge-helpers";

const rangeStart = istInstant(2099, 1, 1);
const rangeEnd = istInstant(2099, 3, 1);

describe("Usage figures reset on the 1st, India time (APL-2641 AC3)", () => {
  const created: { userId?: string; workspaceId?: string } = {};

  afterAll(async () => {
    await db.modelUsage.deleteMany({ where: { createdAt: { gte: rangeStart, lt: rangeEnd } } });
    if (created.userId) await db.user.delete({ where: { id: created.userId } }).catch(() => undefined);
    if (created.workspaceId) await db.workspace.delete({ where: { id: created.workspaceId } }).catch(() => undefined);
    await db.$disconnect();
  });

  it("drops last month's messages and quick actions at 00:00 on the 1st, and never adds quick actions to the message total", async () => {
    await db.modelUsage.deleteMany({ where: { createdAt: { gte: rangeStart, lt: rangeEnd } } });
    const ws = await db.workspace.create({ data: { name: "APL-2641 month reset" } });
    const user = await db.user.create({
      data: {
        workspaceId: ws.id,
        email: `apl2641-${Date.now()}@aplyd.com`,
        name: "Month Reset",
        passwordHash: "not-a-login",
        orgRole: "SUPER_ADMIN",
      },
    });
    created.userId = user.id;
    created.workspaceId = ws.id;
    const sa = { id: user.id, orgRole: "SUPER_ADMIN" as const };
    const lastSecond = istInstant(2099, 1, 31, 23, 59, 59);
    const first = istInstant(2099, 2, 1, 0, 0, 0);

    await db.modelUsage.createMany({
      data: [
        { userId: user.id, model: "m", inputTokens: 10, outputTokens: 5, costUsd: "1.50", counted: true, createdAt: lastSecond },
        // A later call of the same message is not a second message.
        { userId: user.id, model: "m", inputTokens: 4, outputTokens: 2, costUsd: "0.20", counted: false, createdAt: lastSecond },
        { userId: user.id, model: "quick:overdue", inputTokens: 0, outputTokens: 0, costUsd: "0", counted: false, createdAt: lastSecond },
        { userId: user.id, model: "quick:blocked", inputTokens: 0, outputTokens: 0, costUsd: "0", counted: false, createdAt: lastSecond },
      ],
    });

    const january = await usageSummary(sa, lastSecond);
    expect(january.month.messages).toBe(1);
    expect(january.quickActions.find((q) => q.id === "overdue")?.count).toBe(1);
    expect(january.quickActions.find((q) => q.id === "blocked")?.count).toBe(1);
    expect(january.quickActions.find((q) => q.id === "due-week")?.count).toBe(0);

    const fresh = await usageSummary(sa, first);
    expect(fresh.monthStart).toBe(first.toISOString());
    expect(fresh.month.messages).toBe(0);
    expect(fresh.quickActions.map((q) => q.id)).toEqual(QUICK_ACTIONS.map((q) => q.id));
    expect(fresh.quickActions.every((q) => q.count === 0)).toBe(true);

    const html = renderToStaticMarkup(<UsageContents role="SUPER_ADMIN" loading={false} error={null} data={fresh} />);
    expect(html).toMatch(/Messages this month<\/h2>\s*<p class="usage-count">0<\/p>/);
    for (const q of fresh.quickActions) expect(html).toContain(`<dt>${q.label}</dt><dd>0</dd>`);
    expect(html).not.toContain(">17<");

    const justAfter = istInstant(2099, 2, 1, 0, 0, 1);
    await db.modelUsage.createMany({
      data: [
        { userId: user.id, model: "m", inputTokens: 1, outputTokens: 1, costUsd: "0.25", counted: true, createdAt: justAfter },
        { userId: user.id, model: "quick:overdue", inputTokens: 0, outputTokens: 0, costUsd: "0", counted: false, createdAt: justAfter },
      ],
    });
    const february = await usageSummary(sa, justAfter);
    expect(february.month.messages).toBe(1);
    expect(february.quickActions.find((q) => q.id === "overdue")?.count).toBe(1);
    expect(february.quickActions.filter((q) => q.id !== "overdue").every((q) => q.count === 0)).toBe(true);

    await expect(usageSummary({ id: user.id, orgRole: "ADMIN" }, first)).rejects.toMatchObject({ status: 404 });
    await expect(usageSummary({ id: user.id, orgRole: "MEMBER" }, first)).rejects.toMatchObject({ status: 404 });
  });
});
