import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ db: { user: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() }, project: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn() }, projectMember: { create: vi.fn() }, section: { create: vi.fn() }, $transaction: vi.fn() }, log: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: m.db }));
vi.mock("@/lib/notify", () => ({ notify: vi.fn(), logAction: m.log }));
vi.mock("@/lib/deals", () => ({ dealBlock: vi.fn() }));
import { classifyProject, createProject, updateProject, VERTICAL_SUGGESTIONS } from "@/lib/projects";
import { projectAccess } from "@/lib/access";
const admin = { id: "admin", orgRole: "ADMIN" as const };
const member = { id: "lead", orgRole: "MEMBER" as const };
const row = { id: "p", workspaceId: "ws", name: "Legacy project", typeId: "wst_project", isVertical: false, verticalId: null, archivedAt: null, deletedAt: null, members: [{ userId: "lead", role: "LEADER" }] };
beforeEach(() => {
  vi.clearAllMocks();
  m.db.user.findUnique.mockResolvedValue({ id: "lead", workspaceId: "ws", deactivatedAt: null, emailVerifiedAt: new Date() });
  m.db.user.findUniqueOrThrow.mockResolvedValue({ id: "admin", workspaceId: "ws" });
  m.db.project.findUnique.mockResolvedValue(row); m.db.project.findFirst.mockResolvedValue({ id: "vertical" }); m.db.project.count.mockResolvedValue(0);
  m.db.project.create.mockResolvedValue({ id: "created", name: "Growth" });
  m.db.$transaction.mockImplementation(fn => fn(m.db));
});
it("provides the agreed initial vocabulary", () => expect(VERTICAL_SUGGESTIONS).toEqual(["Growth", "Marketing", "Founder's Office"]));
it("members cannot create vertical boards or reclassify existing projects", async () => {
  await expect(createProject(member, { name: "Growth", leaderId: "lead", isVertical: true })).rejects.toMatchObject({ status: 403 });
  await expect(classifyProject(member, "p", true)).rejects.toMatchObject({ status: 403 });
  expect(m.db.project.create).not.toHaveBeenCalled(); expect(m.db.project.update).not.toHaveBeenCalled();
});
it("rejects unavailable/cross-workspace verticals before project creation", async () => {
  m.db.project.findFirst.mockResolvedValue(null);
  await expect(createProject(member, { name: "Delivery", leaderId: "lead", verticalId: "foreign" })).rejects.toMatchObject({ status: 400 });
  expect(m.db.project.findFirst.mock.calls[0][0].where).toMatchObject({ workspaceId: "ws", isVertical: true, archivedAt: null, deletedAt: null });
  expect(m.db.project.create).not.toHaveBeenCalled();
});
it("classification preserves the existing identity and does not create membership", async () => {
  await classifyProject(admin, "p", true);
  expect(m.db.project.update).toHaveBeenCalledWith({ where: { id: "p" }, data: { isVertical: true, verticalId: null } });
  expect(m.db.projectMember.create).not.toHaveBeenCalled();
  expect(m.log.mock.calls[0][1].action).toBe("project.classified");
});
it("linked delivery projects prevent converting their vertical into a delivery project", async () => {
  m.db.project.count.mockResolvedValue(1);
  await expect(classifyProject(admin, "p", false)).rejects.toMatchObject({ status: 409 });
  expect(m.db.project.update).not.toHaveBeenCalled();
});
it("vertical membership alone cannot read a linked delivery project", async () => {
  await expect(projectAccess({ id: "vertical-only-member", orgRole: "MEMBER" }, "p")).rejects.toMatchObject({ status: 404 });
});
it("a vertical-board Leader cannot rename vocabulary or nest its board", async () => {
  m.db.project.findUnique.mockResolvedValue({ ...row, isVertical: true });
  await expect(updateProject(member, "p", { name: "Other" })).rejects.toMatchObject({ status: 403 });
  await expect(updateProject(admin, "p", { verticalId: "vertical" })).rejects.toMatchObject({ status: 400 });
});
