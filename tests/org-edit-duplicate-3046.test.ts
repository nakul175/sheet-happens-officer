import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ findFirst: vi.fn(), update: vi.fn(), log: vi.fn(), transaction: vi.fn(), org: { id: "org", workspaceId: "ws", createdById: "owner", name: "Original", parentId: null as string | null, archivedAt: null as Date | null } }));
vi.mock("@/lib/db", () => ({ db: { user: { findUniqueOrThrow: async () => ({ workspaceId: "ws" }) }, organisation: { findFirst: m.findFirst, findUnique: async () => ({ parentId: null }) }, $transaction: m.transaction } }));
vi.mock("@/lib/access", () => ({ isAdmin: () => false }));
vi.mock("@/lib/crm", () => ({ requireCrm: () => {} }));
vi.mock("@/lib/notify", () => ({ logAction: m.log }));
import { updateOrganisation } from "../src/lib/orgs";
const actor = { id: "owner", name: "Owner", orgRole: "MEMBER" as const };
beforeEach(() => {
  vi.clearAllMocks(); m.org = { id: "org", workspaceId: "ws", createdById: "owner", name: "Original", parentId: null, archivedAt: null };
  m.findFirst.mockImplementation(async ({ where }) => where.id === "org" ? m.org : where.id === "parent" ? { id: "parent", workspaceId: "ws", archivedAt: null } : { id: "other", name: "Existing", archivedAt: new Date() });
  m.update.mockResolvedValue({ id: "org" }); m.transaction.mockImplementation(async fn => fn({ organisation: { update: m.update } }));
});
it("rejects a case-insensitive duplicate rename within the same workspace and parent without writes", async () => {
  await expect(updateOrganisation(actor, "org", { name: " existing " })).rejects.toMatchObject({ status: 409 });
  expect(m.findFirst).toHaveBeenLastCalledWith({ where: { workspaceId: "ws", parentId: null, id: { not: "org" }, name: { equals: "existing", mode: "insensitive" } }, select: { id: true, name: true } });
  expect(m.update).not.toHaveBeenCalled(); expect(m.log).not.toHaveBeenCalled();
});
it("checks the destination parent on a hierarchy move even if the name is unchanged", async () => {
  await expect(updateOrganisation(actor, "org", { parentId: "parent" })).rejects.toMatchObject({ status: 409 });
  expect(m.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ parentId: "parent", name: { equals: "Original", mode: "insensitive" } }) }));
  expect(m.update).not.toHaveBeenCalled();
});
it("does not reject unchanged names when editing other fields, preserving previously confirmed duplicates", async () => {
  await updateOrganisation(actor, "org", { name: " Original ", country: "India" });
  expect(m.findFirst).toHaveBeenCalledTimes(1); expect(m.update).toHaveBeenCalledWith({ where: { id: "org" }, data: { country: "India" } });
});
it("saves a unique trimmed rename and keeps the existing before/after audit", async () => {
  m.findFirst.mockImplementation(async ({ where }) => where.id === "org" ? m.org : null);
  await updateOrganisation(actor, "org", { name: " Unique " });
  expect(m.update).toHaveBeenCalledWith({ where: { id: "org" }, data: { name: "Unique" } });
  expect(m.log).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ before: { name: "Original" }, after: { name: "Unique" } }));
});
it("continues refusing archived organisation edits before duplicate lookups", async () => {
  m.org.archivedAt = new Date();
  await expect(updateOrganisation(actor, "org", { name: "Other" })).rejects.toMatchObject({ status: 409 });
  expect(m.findFirst).toHaveBeenCalledTimes(1); expect(m.transaction).not.toHaveBeenCalled();
});
