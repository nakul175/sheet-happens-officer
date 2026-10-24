import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ access: vi.fn(), log: vi.fn(), tx: { $queryRaw: vi.fn(), project: { findUnique: vi.fn(), update: vi.fn() }, pipeline: { findFirst: vi.fn() }, stage: { findFirst: vi.fn() }, dealDetails: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ db: { $transaction: async (fn: (tx: typeof m.tx) => unknown) => fn(m.tx) } }));
vi.mock("@/lib/access", async (original) => ({ ...await original<typeof import("@/lib/access")>(), projectAccess: m.access }));
vi.mock("@/lib/crm", () => ({ requireCrm: vi.fn(), WORKSTREAM_DEAL: "wst_deal" }));
vi.mock("@/lib/notify", () => ({ logAction: m.log }));
import { sentence } from "@/lib/activity-text";
import { convertProactiveToBid, proactiveToBidInput } from "@/lib/deal-pipeline";
const user = { id: "leader", orgRole: "MEMBER" as const };
const project = { id: "deal", workspaceId: "workspace", typeId: "wst_deal", pipelineId: "pro", stageId: "source-stage", stageReason: "Previous reasoning", stageChangedAt: new Date("2026-10-01"), archivedAt: null, members: [{ userId: "leader", role: "LEADER" }] };
const request = { expectedPipelineId: "pro", expectedStageId: "source-stage", confirmed: true as const, submissionDeadline: "2026-11-01T05:30:00+05:30" };
const source = { id: "pro", key: "DEAL_PROACTIVE", name: "Proactive" }, bid = { id: "bid", key: "DEAL_BID", name: "Bid" };
const leads = { id: "st_bid_identified", pipelineId: "bid", name: "Leads", category: "ACTIVE", isRetired: false };
beforeEach(() => {
  vi.resetAllMocks();
  m.access.mockResolvedValue({ project, role: "LEADER" });
  m.tx.project.findUnique.mockResolvedValue(project);
  m.tx.pipeline.findFirst.mockImplementation(async ({ where }) => where.key === "DEAL_PROACTIVE" ? source : bid);
  m.tx.stage.findFirst.mockImplementation(async ({ where }) => where.id === "source-stage" ? { id: "source-stage", name: "Conversation", category: "ACTIVE" } : leads);
  m.tx.dealDetails.findUnique.mockResolvedValue({ submissionDeadline: new Date("2026-10-20"), submissionDeadlineHasTime: false });
});
describe("SHO-3053 explicit Proactive→Bid conversion", () => {
  it("renders a readable distinct conversion history action", () => { expect(sentence({ action: "deal.pipeline_converted", targetId: "deal", beforeState: {}, afterState: {} }, new Map())).toBe("converted the deal from Proactive to Bid Leads"); });
  it("requires confirmation, expected pipeline/stage and a valid deadline; derives precision", () => {
    expect(proactiveToBidInput.parse({ ...request, submissionDeadlineHasTime: false })).toEqual(request);
    for (const input of [{ ...request, confirmed: false }, { ...request, expectedPipelineId: "" }, { ...request, submissionDeadline: null }, { ...request, submissionDeadline: "2026-02-30" }]) expect(proactiveToBidInput.safeParse(input).success).toBe(false);
  });
  it("moves the same project to exact Bid Leads, changes only deadline details and logs full before/after without Undo", async () => {
    expect(await convertProactiveToBid(user, "deal", request)).toEqual({ pipelineId: "bid", stageId: "st_bid_identified" });
    expect(m.tx.$queryRaw.mock.calls[0][0].join("?")).toContain('FROM "Project" WHERE "id" = ? FOR UPDATE');
    expect(m.tx.dealDetails.update).toHaveBeenCalledWith({ where: { projectId: "deal" }, data: { submissionDeadline: new Date("2026-11-01T00:00:00Z"), submissionDeadlineHasTime: true } });
    expect(m.tx.project.update).toHaveBeenCalledWith({ where: { id: "deal" }, data: { pipelineId: "bid", stageId: "st_bid_identified", stageReason: null, stageChangedAt: expect.any(Date) } });
    expect(m.log).toHaveBeenCalledWith(m.tx, expect.objectContaining({ action: "deal.pipeline_converted", primary: false, before: expect.objectContaining({ pipelineId: "pro", stageId: "source-stage", stageReason: "Previous reasoning", submissionDeadline: "2026-10-20" }), after: expect.objectContaining({ pipelineId: "bid", stageId: "st_bid_identified", submissionDeadlineHasTime: true, submissionDeadline: "2026-11-01T00:00:00.000Z" }) }));
  });
  it.each(["NOT_STARTED", "ACTIVE", "PAUSED"])("allows open source category %s and preserves date-only input precision", async (category) => {
    m.tx.stage.findFirst.mockImplementation(async ({ where }) => where.id === "source-stage" ? { id: "source-stage", name: "Current", category } : leads);
    await convertProactiveToBid(user, "deal", { ...request, submissionDeadline: "2026-11-01" });
    expect(m.tx.dealDetails.update).toHaveBeenCalledWith(expect.objectContaining({ data: { submissionDeadline: new Date("2026-11-01"), submissionDeadlineHasTime: false } }));
  });
  it.each(["DONE", "LOST", "DELIVERY"])("refuses %s without reversing outcomes or touching details", async (category) => {
    m.tx.stage.findFirst.mockResolvedValue({ id: "source-stage", category });
    await expect(convertProactiveToBid(user, "deal", request)).rejects.toMatchObject({ status: 409 });
    expect(m.tx.dealDetails.update).not.toHaveBeenCalled(); expect(m.tx.project.update).not.toHaveBeenCalled();
  });
  it.each(["EDITOR", "VIEWER"])("does not extend %s authority", async (role) => {
    m.access.mockResolvedValue({ project, role });
    await expect(convertProactiveToBid(user, "deal", request)).rejects.toMatchObject({ status: 403 });
    expect(m.tx.$queryRaw).not.toHaveBeenCalled();
  });
  it("retains outsider404 and Admin management authority", async () => {
    m.access.mockRejectedValueOnce({ status: 404 });
    await expect(convertProactiveToBid(user, "deal", request)).rejects.toMatchObject({ status: 404 });
    m.tx.project.findUnique.mockResolvedValue({ ...project, members: [] });
    await expect(convertProactiveToBid({ id: "admin", orgRole: "ADMIN" }, "deal", request)).resolves.toMatchObject({ pipelineId: "bid" });
  });
  it("rejects stale pipeline/stage, archived projects and membership removed/demoted under lock", async () => {
    for (const changed of [{ ...project, pipelineId: "bid" }, { ...project, stageId: "new-stage" }, { ...project, archivedAt: new Date() }, { ...project, members: [] }, { ...project, members: [{ userId: "leader", role: "EDITOR" }] }]) {
      m.tx.project.findUnique.mockResolvedValue(changed);
      await expect(convertProactiveToBid(user, "deal", request)).rejects.toBeDefined();
    }
    expect(m.tx.project.update).not.toHaveBeenCalled();
  });
  it("rejects non-Proactive pipelines and unavailable/retired/customized source or neutral target stages", async () => {
    m.tx.pipeline.findFirst.mockResolvedValueOnce(null);
    await expect(convertProactiveToBid(user, "deal", request)).rejects.toMatchObject({ status: 409 });
    m.tx.stage.findFirst.mockResolvedValueOnce(null);
    await expect(convertProactiveToBid(user, "deal", request)).rejects.toMatchObject({ status: 409 });
    m.tx.stage.findFirst.mockImplementation(async ({ where }) => where.id === "source-stage" ? { id: "source-stage", name: "Current", category: "ACTIVE" } : null);
    await expect(convertProactiveToBid(user, "deal", request)).rejects.toMatchObject({ status: 409 });
    expect(m.tx.stage.findFirst).toHaveBeenCalledWith({ where: { id: "st_bid_identified", pipelineId: "bid", name: "Leads", isRetired: false, category: "ACTIVE", needsReason: false, requiredFields: { isEmpty: true } } });
    expect(m.tx.project.update).not.toHaveBeenCalled();
  });
});
