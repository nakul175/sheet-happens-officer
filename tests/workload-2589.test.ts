import { afterEach, beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  me: vi.fn(), people: vi.fn(), projects: vi.fn(), group: vi.fn(), transaction: vi.fn(), assigneeField: { modelName: "Task", name: "assigneeId" },
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: m.transaction } }));
import { workloadEnabled, workloadMetricScope, workloadProjectScope, workloadSummary, workloadTaskScope } from "../src/lib/workload";
const admin = { id: "admin", orgRole: "ADMIN" as const };
const leader = { id: "leader", orgRole: "MEMBER" as const };
const now = new Date("2026-10-27T18:30:00.000Z"); // midnight 28 October IST
beforeEach(() => {
  vi.stubEnv("FF_WORKLOAD", "on"); vi.stubEnv("CRM_VISIBLE", "all");
  m.transaction.mockImplementation(async f => f({ user: { findUniqueOrThrow: m.me, findMany: m.people }, project: { findMany: m.projects }, task: { groupBy: m.group, fields: { assigneeId: m.assigneeField } } }));
  m.me.mockResolvedValue({ workspaceId: "workspace" });
  m.projects.mockResolvedValue([{ id: "live-project" }]);
  m.people.mockResolvedValue([{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }, { id: "c", name: "Carol" }, { id: "d", name: "Dana" }]);
  m.group.mockResolvedValue([]);
});
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
it("is off by default and refuses the read before touching the database", async () => {
  expect(workloadEnabled({})).toBe(false);
  vi.stubEnv("FF_WORKLOAD", "off");
  await expect(workloadSummary(admin, now)).rejects.toMatchObject({ status: 404 });
  expect(m.transaction).not.toHaveBeenCalled();
});
it.each(["1", "true", "on", "yes", " ON "])("recognises the explicit opt-in %s", value => {
  expect(workloadEnabled({ FF_WORKLOAD: value })).toBe(true);
});
it("denies an ordinary Member without eligible led projects and performs no task reads", async () => {
  m.projects.mockResolvedValue([]);
  await expect(workloadSummary(leader, now)).rejects.toMatchObject({ status: 404 });
  expect(m.people).not.toHaveBeenCalled(); expect(m.group).not.toHaveBeenCalled();
});
it("restricts leaders to their own live workspace projects and people on those projects", async () => {
  await workloadSummary(leader, now);
  expect(m.projects.mock.calls[0][0].where).toEqual({ workspaceId: "workspace", archivedAt: null, deletedAt: null, members: { some: { userId: "leader", role: "LEADER" } } });
  expect(m.people.mock.calls[0][0].where).toEqual({ workspaceId: "workspace", memberships: { some: { projectId: { in: ["live-project"] } } } });
  for (const [query] of m.group.mock.calls) expect(query.where.AND[0]).toEqual(workloadTaskScope(["live-project"]));
});
it("counts each metric independently, sorts overdue before open and retains zero-work people", async () => {
  const row = (assigneeId: string, n: number) => ({ assigneeId, _count: { _all: n } });
  m.group.mockResolvedValueOnce([row("a", 2), row("b", 1), row("c", 1)])
    .mockResolvedValueOnce([row("b", 1)]).mockResolvedValueOnce([row("b", 1)])
    .mockResolvedValueOnce([row("c", 1)]).mockResolvedValueOnce([row("a", 1)]);
  const result = await workloadSummary(admin, now);
  expect(result.items.map(p => p.id)).toEqual(["b", "a", "c", "d"]);
  expect(result.items.find(p => p.id === "c")).toMatchObject({ open: 1, due: 0, overdue: 0, approval: 1, blocked: 0 });
  expect(result.items.at(-1)).toEqual({ id: "d", name: "Dana", open: 0, due: 0, overdue: 0, approval: 0, blocked: 0 });
  expect(m.people.mock.calls[0][0].where).toEqual({ workspaceId: "workspace" });
  expect(m.group.mock.calls[3][0].where.AND[1]).toEqual({ approverId: { equals: m.assigneeField } });
  expect(m.transaction.mock.calls[0][1]).toEqual({ isolationLevel: "RepeatableRead" });
});
it("uses IST midnight and a seven-calendar-date half-open due window", () => {
  expect(workloadMetricScope("due", now)).toEqual({ dueDate: { gte: new Date("2026-10-27T18:30:00.000Z"), lt: new Date("2026-11-03T18:30:00.000Z") } });
  expect(workloadMetricScope("overdue", new Date(now.getTime() - 1))).toEqual({ dueDate: { lt: new Date("2026-10-26T18:30:00.000Z") } });
});
it.each(["off", "admins"])("excludes hidden CRM from a Leader's scope in %s mode", mode => {
  vi.stubEnv("CRM_VISIBLE", mode);
  expect(workloadProjectScope(leader, "workspace")).toMatchObject({ typeId: { not: "wst_deal" } });
});
it("excludes hidden CRM even for an Admin when the CRM is off", () => {
  vi.stubEnv("CRM_VISIBLE", "off");
  expect(workloadProjectScope(admin, "workspace")).toEqual({ workspaceId: "workspace", archivedAt: null, deletedAt: null, typeId: { not: "wst_deal" } });
});
