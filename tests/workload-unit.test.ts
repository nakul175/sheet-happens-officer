import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ user: { findUnique: vi.fn(), findMany: vi.fn() }, project: { findMany: vi.fn() }, task: { findMany: vi.fn() }, projectMember: { findFirst: vi.fn() } }));
vi.mock("@/lib/db", () => ({ db: mocks }));
import { matchesWorkload, workload, workloadAvailable } from "@/lib/workload";
import { parseDueDate } from "@/lib/dates";
const leader = { id: "lead", orgRole: "MEMBER" as const };
const admin = { id: "admin", orgRole: "ADMIN" as const };
const task = { id: "t1", projectId: "p1", title: "Private task", assigneeId: "worker", approverId: null, dueDate: parseDueDate("2026-10-20"), blocked: false, updatedAt: new Date() };
beforeEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs();
  mocks.user.findUnique.mockResolvedValue({ workspaceId: "w", deactivatedAt: null, emailVerifiedAt: new Date() });
  mocks.project.findMany.mockResolvedValue([{ id: "p1", name: "Ops", typeId: "wst_project", members: [{ userId: "worker" }] }]);
  mocks.user.findMany.mockResolvedValue([{ id: "worker", name: "Worker" }, { id: "lead", name: "Leader" }]);
  mocks.task.findMany.mockResolvedValue([task]);
});
describe("SHO-2589 workload", () => {
  it("uses India calendar boundaries, including today plus the next seven days", () => {
    const today = parseDueDate("2026-10-28");
    const t = { ...task, dueDate: today };
    expect(matchesWorkload(t, "overdue", today)).toBe(false);
    expect(matchesWorkload(t, "next7", today)).toBe(true);
    expect(matchesWorkload({ ...t, dueDate: parseDueDate("2026-11-04") }, "next7", today)).toBe(true);
    expect(matchesWorkload({ ...t, dueDate: parseDueDate("2026-11-05") }, "next7", today)).toBe(false);
    expect(matchesWorkload({ ...t, dueDate: null }, "next7", today)).toBe(false);
    expect(matchesWorkload({ ...t, dueDate: parseDueDate("2026-10-27") }, "overdue", today)).toBe(true);
    expect(matchesWorkload({ ...t, approverId: "worker" }, "awaiting", today)).toBe(true);
    expect(matchesWorkload({ ...t, approverId: "lead" }, "awaiting", today)).toBe(false);
    expect(matchesWorkload({ ...t, blocked: true }, "blocked", today)).toBe(true);
  });
  it("limits Leaders to their active led projects and those projects' active members", async () => {
    const result = await workload(leader);
    expect(mocks.project.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "w", archivedAt: null, members: { some: { userId: "lead", role: "LEADER" } } });
    expect(mocks.user.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: "w", deactivatedAt: null, emailVerifiedAt: { not: null }, id: { in: ["worker"] } });
    expect(mocks.task.findMany.mock.calls[0][0].where).toMatchObject({ workspaceId: "w", projectId: { in: ["p1"] }, deletedAt: null, completedAt: null, OR: [{ parentId: null }, { parent: { deletedAt: null } }] });
    expect(result.people[0].counts).toMatchObject({ open: 1, overdue: 1, blocked: 0, awaiting: 0 });
  });
  it("reports Members without leadership as not found before loading people or tasks", async () => {
    mocks.project.findMany.mockResolvedValue([]);
    await expect(workload(leader)).rejects.toMatchObject({ status: 404 });
    expect(mocks.task.findMany).not.toHaveBeenCalled();
    expect(mocks.user.findMany).not.toHaveBeenCalled();
  });
  it("lets Admins count the whole workspace, including people with no tasks", async () => {
    const result = await workload(admin);
    expect(mocks.project.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "w", archivedAt: null });
    expect(mocks.user.findMany.mock.calls[0][0].where.id).toBeUndefined();
    expect(result.people.find(p => p.id === "lead")?.counts.open).toBe(0);
  });
  it("sorts overdue then open and uses exactly the same filter for counts and drill-down", async () => {
    mocks.task.findMany.mockResolvedValue([task, { ...task, id: "t2", assigneeId: "lead", dueDate: null, blocked: true }, { ...task, id: "t3", assigneeId: "lead", dueDate: null }]);
    const r = await workload(admin, new URLSearchParams({ assignee: "lead", f: "blocked" }));
    expect(r.people.map(p => p.id)).toEqual(["worker", "lead"]);
    expect(r.people.find(p => p.id === "lead")?.counts.blocked).toBe(r.items.length);
    expect(r.items.map(t => t.id)).toEqual(["t2"]);
    await expect(workload(leader, new URLSearchParams({ assignee: "outsider" }))).rejects.toMatchObject({ status: 404 });
  });
  it("counts deal work but redacts hidden CRM names, task text and identifiers", async () => {
    vi.stubEnv("CRM_VISIBLE", "off");
    mocks.project.findMany.mockResolvedValue([{ id: "p1", name: "Secret bid", typeId: "wst_deal", members: [] }]);
    const r = await workload(admin, new URLSearchParams({ assignee: "worker" }));
    expect(r.people[0].counts.open).toBe(1);
    expect(r.items[0]).toMatchObject({ id: null, title: "Task in a deal", project: { id: null, name: "a deal" } });
    expect(JSON.stringify(r)).not.toMatch(/Secret bid|Private task|p1|t1/);
  });
  it("rejects inactive accounts and offers navigation only to Admins or Leaders", async () => {
    mocks.user.findUnique.mockResolvedValue({ workspaceId: "w", deactivatedAt: new Date(), emailVerifiedAt: new Date() });
    await expect(workload(admin)).rejects.toMatchObject({ status: 404 });
    expect(await workloadAvailable(admin)).toBe(true);
    mocks.projectMember.findFirst.mockResolvedValue(null);
    expect(await workloadAvailable(leader)).toBe(false);
  });
});
