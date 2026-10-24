import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({
  access: vi.fn(), log: vi.fn(),
  tx: { $queryRaw: vi.fn(), project: { findUnique: vi.fn(), findFirst: vi.fn() }, dealParty: { findFirst: vi.fn(), update: vi.fn() }, organisation: { findFirst: vi.fn() } },
}));
vi.mock("@/lib/db", () => ({ db: { $transaction: async (fn: (tx: typeof m.tx) => unknown) => fn(m.tx) } }));
vi.mock("@/lib/access", async (original) => ({ ...await original<typeof import("@/lib/access")>(), projectAccess: m.access }));
vi.mock("@/lib/notify", () => ({ logAction: m.log }));
vi.mock("@/lib/crm", () => ({ requireCrm: vi.fn(), WORKSTREAM_DEAL: "wst_deal" }));
import { replaceDealBuyer, dealBuyerReplacement } from "@/lib/deal-buyer";
const user = { id: "leader", orgRole: "MEMBER" as const };
const project = { id: "deal", workspaceId: "workspace", typeId: "wst_deal", name: "Opportunity", archivedAt: null, members: [{ userId: "leader", role: "LEADER" }] };
const request = { organisationId: "new", expectedOrganisationId: "old" };
beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ project, role: "LEADER" });
  m.tx.project.findUnique.mockResolvedValue(project);
  m.tx.project.findFirst.mockResolvedValue(null);
  m.tx.dealParty.findFirst.mockResolvedValue({ id: "party", organisationId: "old", organisation: { id: "old", name: "Old Buyer" } });
  m.tx.organisation.findFirst.mockResolvedValue({ id: "new", workspaceId: "workspace", name: "New Buyer", archivedAt: null });
});
describe("SHO-3052 controlled existing Buyer relationship replacement", () => {
  it("requires both an existing selection and the Buyer originally seen", () => {
    expect(dealBuyerReplacement.safeParse(request).success).toBe(true);
    expect(dealBuyerReplacement.safeParse({ organisationId: "new" }).success).toBe(false);
    expect(dealBuyerReplacement.safeParse({ ...request, organisationId: " " }).success).toBe(false);
  });
  it("updates only the existing Buyer relation and audits old/new Account IDs without unsupported Undo", async () => {
    expect(await replaceDealBuyer(user, "deal", request)).toEqual({ changed: true });
    expect(m.access).toHaveBeenCalledWith(user, "deal", { write: true });
    expect(m.tx.$queryRaw.mock.calls[0][0].join("?")).toContain('FROM "Project" WHERE "id" = ? FOR UPDATE');
    const lock = m.tx.$queryRaw.mock.calls.find((call) => call[0].join("?").includes("pg_advisory_xact_lock"))!;
    expect(lock[0].join("?")).toContain("lower(?::text)");
    expect(lock.slice(1)).toEqual(["workspace", "new", "Opportunity"]);
    const lockIndex = m.tx.$queryRaw.mock.calls.indexOf(lock);
    expect(m.tx.$queryRaw.mock.invocationCallOrder[lockIndex]).toBeLessThan(m.tx.project.findFirst.mock.invocationCallOrder[0]);
    expect(m.tx.project.findFirst.mock.invocationCallOrder[0]).toBeLessThan(m.tx.dealParty.update.mock.invocationCallOrder[0]);
    expect(m.tx.organisation.findFirst).toHaveBeenCalledWith({ where: { id: "new", workspaceId: "workspace" } });
    expect(m.tx.dealParty.update).toHaveBeenCalledWith({ where: { id: "party" }, data: { organisationId: "new" } });
    expect(m.log).toHaveBeenCalledWith(m.tx, expect.objectContaining({ action: "deal.buyer_changed", primary: false, before: { partyId: "party", organisationId: "old", organisation: "Old Buyer" }, after: { partyId: "party", organisationId: "new", organisation: "New Buyer" } }));
  });
  it("allows existing Admin management authority without requiring project membership", async () => {
    m.tx.project.findUnique.mockResolvedValue({ ...project, members: [] });
    await expect(replaceDealBuyer({ id: "admin", orgRole: "ADMIN" }, "deal", request)).resolves.toEqual({ changed: true });
  });
  it.each(["EDITOR", "VIEWER"])("refuses %s management changes", async (role) => {
    m.access.mockResolvedValue({ project, role });
    await expect(replaceDealBuyer(user, "deal", request)).rejects.toMatchObject({ status: 403 });
    expect(m.tx.dealParty.update).not.toHaveBeenCalled();
  });
  it("preserves outsider not-found semantics", async () => {
    m.access.mockRejectedValue({ status: 404 });
    await expect(replaceDealBuyer(user, "deal", request)).rejects.toMatchObject({ status: 404 });
    expect(m.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it("rechecks archive and removed/demoted membership after acquiring project lock", async () => {
    for (const changedProject of [{ ...project, archivedAt: new Date() }, { ...project, members: [] }, { ...project, members: [{ userId: "leader", role: "EDITOR" }] }]) {
      m.tx.project.findUnique.mockResolvedValue(changedProject);
      await expect(replaceDealBuyer(user, "deal", request)).rejects.toBeDefined();
    }
    expect(m.tx.dealParty.update).not.toHaveBeenCalled();
  });
  it("refuses stale replacement with 409 and does not log or change anything", async () => {
    m.tx.dealParty.findFirst.mockResolvedValue({ id: "party", organisationId: "newer", organisation: { name: "Newer Buyer" } });
    await expect(replaceDealBuyer(user, "deal", request)).rejects.toMatchObject({ status: 409 });
    expect(m.tx.dealParty.update).not.toHaveBeenCalled(); expect(m.log).not.toHaveBeenCalled();
  });
  it("same Buyer is a no-op with no action or Account lookup", async () => {
    await expect(replaceDealBuyer(user, "deal", { ...request, organisationId: "old" })).resolves.toEqual({ changed: false });
    expect(m.tx.dealParty.update).not.toHaveBeenCalled(); expect(m.log).not.toHaveBeenCalled(); expect(m.tx.organisation.findFirst).not.toHaveBeenCalled();
  });
  it("refuses missing/cross-workspace or archived target Accounts", async () => {
    m.tx.organisation.findFirst.mockResolvedValue(null);
    await expect(replaceDealBuyer(user, "deal", request)).rejects.toMatchObject({ status: 400 });
    m.tx.organisation.findFirst.mockResolvedValue({ id: "new", archivedAt: new Date() });
    await expect(replaceDealBuyer(user, "deal", request)).rejects.toMatchObject({ status: 409 });
    expect(m.tx.dealParty.update).not.toHaveBeenCalled();
  });
  it("refuses a duplicate deal name for target Buyer including archived deals", async () => {
    m.tx.project.findFirst.mockResolvedValue({ id: "duplicate" });
    await expect(replaceDealBuyer(user, "deal", request)).rejects.toMatchObject({ status: 409 });
    expect(m.tx.project.findFirst.mock.calls[0][0].where).not.toHaveProperty("archivedAt");
    expect(m.tx.dealParty.update).not.toHaveBeenCalled();
  });
  it("refuses non-deals and missing Buyer invariant without constructing a new relation", async () => {
    m.access.mockResolvedValueOnce({ project: { ...project, typeId: "wst_project" }, role: "LEADER" });
    await expect(replaceDealBuyer(user, "deal", request)).rejects.toMatchObject({ status: 400 });
    m.tx.dealParty.findFirst.mockResolvedValue(null);
    await expect(replaceDealBuyer(user, "deal", request)).rejects.toMatchObject({ status: 409 });
    expect(m.tx.dealParty.update).not.toHaveBeenCalled();
  });
});
