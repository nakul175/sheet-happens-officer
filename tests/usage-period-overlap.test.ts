import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ at: new Date(0), aggregate: vi.fn(), groupBy: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {
  modelUsage: { aggregate: fixture.aggregate, groupBy: fixture.groupBy },
  user: {findMany: async () => [{id: "qa-user", name: "Synthetic usage person"}]},
} }));
import { usageSummary } from "../src/lib/usage";
beforeEach(() => {
  fixture.aggregate.mockReset().mockImplementation(async ({where}) => ({_count: fixture.at >= where.createdAt.gte ? 1 : 0, _sum: {costUsd: 0, inputTokens: 0, outputTokens: 0}}));
  fixture.groupBy.mockReset().mockImplementation(async ({where, by}) => {
    if (fixture.at < where.createdAt.gte || by[0] === "model") return [];
    return [{userId: "qa-user", _count: 1, _sum: {costUsd: 0}}];
  });
});
it.each([
  ["2026-11-01T00:00:00+05:30", "2026-10-31T12:00:00+05:30", "2026-10-25T18:30:00.000Z", 1],
  ["2026-06-01T00:00:00+05:30", "2026-05-31T12:00:00+05:30", "2026-05-31T18:30:00.000Z", 0],
  ["2027-01-01T00:00:00+05:30", "2026-12-31T12:00:00+05:30", "2026-12-27T18:30:00.000Z", 1],
])("monthly reset at %s preserves only applicable weekly usage", async (boundary, prior, weekStart, weeklyCount) => {
  fixture.at = new Date(prior);
  const result = await usageSummary({id: "qa-admin", orgRole: "SUPER_ADMIN"}, new Date(boundary));
  expect(result.monthStart).toBe(new Date(boundary).toISOString());
  expect(result.weekStart).toBe(weekStart);
  expect(result.month).toMatchObject({messages: 0, calls: 0, costUsd: 0});
  if (weeklyCount === 0) expect(result.people).toEqual([]);
  else expect(result.people).toEqual([expect.objectContaining({id: "qa-user", monthCalls: 0, monthMessages: 0, monthCostUsd: 0, weekCalls: 1, weekMessages: 1})]);
});
