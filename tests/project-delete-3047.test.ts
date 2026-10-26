import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ project: { findUnique: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() }, projectMember: { findMany: vi.fn() }, transaction: vi.fn(), notify: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { project: m.project, projectMember: m.projectMember, $transaction: m.transaction } }));
vi.mock("@/lib/notify", () => ({ notify: m.notify, logAction: m.log }));
vi.mock("@/lib/deals", () => ({ dealBlock: vi.fn() }));
import { projectAccess } from "@/lib/access";
import { deleteProject, restoreProject, listProjects } from "@/lib/projects";
const lead = { id: "lead", orgRole: "MEMBER" as const };
const editor = { id: "editor", orgRole: "MEMBER" as const };
const admin = { id: "admin", orgRole: "ADMIN" as const };
const original = { id: "p", name: "Keep history", typeId: "wst_project", archivedAt: null as Date | null, deletedAt: null as Date | null, deletedPreviousArchivedAt: null as Date | null, updatedAt: new Date("2026-10-01"), members: [{ userId: "lead", role: "LEADER" }, { userId: "editor", role: "EDITOR" }, { userId: "viewer", role: "VIEWER" }] };
beforeEach(() => {
  vi.clearAllMocks(); m.project.findUnique.mockResolvedValue({ ...original });
  m.project.updateMany.mockResolvedValue({ count: 1 });
  m.transaction.mockImplementation(async fn => fn({ project: m.project }));
  m.project.findMany.mockResolvedValue([]); m.projectMember.findMany.mockResolvedValue([]);
});
it.each([lead, admin])("Leader/Admin deletes recoverably with exact confirmation", async actor => {
  await expect(deleteProject(actor, "p", "Keep history")).resolves.toEqual({ deleted: true });
  expect(m.project.updateMany.mock.calls[0][0].data).toMatchObject({ deletedAt: expect.any(Date), archivedAt: expect.any(Date), deletedPreviousArchivedAt: null });
  expect(m.notify).toHaveBeenCalledWith(expect.anything(), ["lead", "editor", "viewer"], "PROJECT_DELETED", expect.anything());
  expect(m.log.mock.calls[0][1]).toMatchObject({ action: "project.deleted", after: { recoverable: true } });
});
it.each([editor, { id: "viewer", orgRole: "MEMBER" as const }])("rejects non-managing roles", async actor => {
  await expect(deleteProject(actor, "p", "Keep history")).rejects.toMatchObject({ status: 403 });
  expect(m.transaction).not.toHaveBeenCalled();
});
it("rejects outsiders, mismatched name, unsupported work items and stale deletion", async () => {
  await expect(deleteProject({ id: "outside", orgRole: "MEMBER" }, "p", "Keep history")).rejects.toMatchObject({ status: 404 });
  await expect(deleteProject(lead, "p", "wrong")).rejects.toMatchObject({ status: 400 });
  m.project.findUnique.mockResolvedValue({ ...original, typeId: "wst_other" });
  await expect(deleteProject(admin, "p", "Keep history")).rejects.toMatchObject({ status: 400 });
  m.project.findUnique.mockResolvedValue(original); m.project.updateMany.mockResolvedValue({ count: 0 });
  await expect(deleteProject(lead, "p", "Keep history")).rejects.toMatchObject({ status: 409 });
});
it("moves a deal to the same recoverable Trash workflow", async () => {
  m.project.findUnique.mockResolvedValue({ ...original, typeId: "wst_deal" });
  await expect(deleteProject(lead, "p", "Keep history")).resolves.toEqual({ deleted: true });
  expect(m.project.updateMany.mock.calls[0][0].data).toMatchObject({ deletedAt: expect.any(Date), archivedAt: expect.any(Date) });
});
it.each([null, new Date("2026-09-01")])("restores previous archive state %s without changing linked rows", async archived => {
  m.project.findUnique.mockResolvedValue({ ...original, deletedAt: new Date(), archivedAt: new Date(), deletedPreviousArchivedAt: archived });
  await expect(projectAccess(lead, "p")).rejects.toMatchObject({ status: 404 });
  await expect(projectAccess(editor, "p", { deleted: true })).rejects.toMatchObject({ status: 404 });
  await expect(restoreProject(lead, "p")).resolves.toEqual({ restored: true });
  expect(m.project.updateMany.mock.calls[0][0].data).toEqual({ deletedAt: null, archivedAt: archived, deletedPreviousArchivedAt: null });
  expect(m.log.mock.calls[0][1].action).toBe("project.restored");
});
it("Trash query restricts members to their Leader seat; normal and archived lists exclude deleted", async () => {
  await listProjects(editor, false, true);
  expect(m.project.findMany.mock.calls[0][0].where).toMatchObject({ deletedAt: { not: null }, members: { some: { userId: "editor", role: "LEADER" } } });
  await listProjects(lead, true);
  expect(m.project.findMany.mock.calls[1][0].where).toMatchObject({ deletedAt: null, archivedAt: { not: null } });
});
