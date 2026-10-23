// SHO-3012: pin the real behaviour of ceiling.percent in src/lib/usage.ts before correcting its comment.
// MONTHLY_CEILING_USD unset (or 0, empty or junk) is not "no ceiling": monthlyCeilingUsd() is then the
// $100 default safety cap, which still applies (APL-2950). So percent is the whole number worked out
// against $100, never 0 for a missing ceiling. It is 0 only when the screen's label is "0%" or "<1%".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usageSummary } from "@/lib/usage";
import { monthlyCeilingConfigured, monthlyCeilingUsd } from "@/lib/concierge/limits";
import { percentUsedNumber, percentUsedLabel } from "@/lib/usage-percent";
import { db } from "./concierge-helpers";

const RUN = `${Date.now().toString(36)}${process.pid.toString(36)}`;
// 10:00 India time on 17 March 2031: a month no other suite writes ledger rows to, so the figures are this suite's.
const MONTH = new Date(Date.UTC(2031, 2, 17, 4, 30));
const ENV = "MONTHLY_CEILING_USD";
const SPEND_USD = 50;

describe("SHO-3012: ceiling.percent when MONTHLY_CEILING_USD is unset", () => {
  let workspaceId = "";
  let userId = "";
  const saved = process.env[ENV];

  beforeAll(async () => {
    const ws = await db.workspace.create({ data: { name: `ZZ-TEST SHO-3012 ${RUN}` } });
    workspaceId = ws.id;
    const u = await db.user.create({
      data: {
        workspaceId,
        name: "ZZ-TEST SHO-3012",
        email: `zz-3012-${RUN}@aplyd.com`,
        passwordHash: "not-used",
        orgRole: "SUPER_ADMIN",
        emailVerifiedAt: MONTH,
      },
    });
    userId = u.id;
    // Two calls, $30 + $20, both inside March 2031.
    await db.modelUsage.createMany({
      data: [
        { userId, model: "fake", inputTokens: 10, outputTokens: 5, costUsd: "30", counted: true, createdAt: MONTH },
        { userId, model: "fake", inputTokens: 10, outputTokens: 5, costUsd: "20", counted: true, createdAt: MONTH },
      ],
    });
  });

  afterAll(async () => {
    try {
      if (userId) await db.modelUsage.deleteMany({ where: { userId } });
      if (userId) await db.user.delete({ where: { id: userId } });
      if (workspaceId) await db.workspace.delete({ where: { id: workspaceId } });
    } finally {
      await db.$disconnect();
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
    }
  });

  const summary = () => usageSummary({ id: userId, orgRole: "SUPER_ADMIN" }, MONTH);

  it("works the percentage out against the $100 safety cap when the variable is unset, not 0", async () => {
    delete process.env[ENV];
    expect(monthlyCeilingConfigured()).toBe(false);
    expect(monthlyCeilingUsd()).toBe(100);

    const s = await summary();
    expect(s.ceiling.configured).toBe(false);
    expect(s.ceiling.usd).toBe(100);
    expect(s.ceiling.spendUsd).toBe(SPEND_USD);
    // The real behaviour: $50 of the $100 default safety cap. 0 would be the stale comment's claim.
    expect(s.ceiling.percent).toBe(50);
  });

  it("treats 0, empty and junk as no set ceiling, and still works the percentage out against $100", async () => {
    for (const v of ["", "0", "-5", "abc"]) {
      process.env[ENV] = v;
      expect(monthlyCeilingConfigured(), JSON.stringify(v)).toBe(false);
      expect(monthlyCeilingUsd(), JSON.stringify(v)).toBe(100);
      expect((await summary()).ceiling.percent, JSON.stringify(v)).toBe(50);
    }
  });

  it("is 0 only when the label is 0% or <1%, and follows a set ceiling", async () => {
    // The other half of the comment stays true: the stored number is 0 when the screen prints "0%" or "<1%".
    expect(percentUsedLabel(0, 100)).toBe("0%");
    expect(percentUsedNumber(0, 100)).toBe(0);
    expect(percentUsedLabel(0.4, 100)).toBe("<1%");
    expect(percentUsedNumber(0.4, 100)).toBe(0);
    expect(percentUsedNumber(50, 100)).toBe(50);

    process.env[ENV] = "200";
    const s = await summary();
    expect(s.ceiling.configured).toBe(true);
    expect(s.ceiling.usd).toBe(200);
    expect(s.ceiling.percent).toBe(25);
  });
});
