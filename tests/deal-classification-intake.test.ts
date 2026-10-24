import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { dealCreate, dealDetails, taskConvert } from "@/lib/schemas";
import { ATHENA_ENTITIES, OPPORTUNITY_TYPES, netFeeRevenueUsdField } from "@/lib/deal-classification";
const m = vi.hoisted(() => ({ db: { $queryRaw: vi.fn(), user: { findUniqueOrThrow: vi.fn(), findUnique: vi.fn() }, pipeline: { findFirst: vi.fn() }, project: { findFirst: vi.fn(), create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() }, projectMember: { create: vi.fn() }, section: { create: vi.fn() }, dealDetails: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() }, dealParty: { create: vi.fn() }, task: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), groupBy: vi.fn(), update: vi.fn() }, actionLog: { groupBy: vi.fn() }, note: { groupBy: vi.fn() }, taskCollaborator: { deleteMany: vi.fn() }, $transaction: vi.fn() }, access: vi.fn(), requireWrite: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: m.db }));
vi.mock("@/lib/access", () => ({ isActive: () => true, isAdmin: () => false, projectAccess: m.access, requireWrite: m.requireWrite }));
vi.mock("@/lib/notify", () => ({ auditTx: vi.fn(), logAction: m.log, notify: vi.fn() }));
vi.mock("@/lib/orgs", () => ({ orgOf: async () => ({ id: "org", name: "Buyer", archivedAt: null }) }));
vi.mock("@/lib/tasks", () => ({ taskAccess: m.access }));
vi.mock("@/lib/crm", () => ({ WORKSTREAM_DEAL: "type_deal", requireCrm: vi.fn(), crmMode: () => "on", crmVisible: () => true, crmProjectWhere: () => ({}) }));
import { createDeal, convertTaskToDeal, updateDealDetails, listDeals, dealBlock } from "@/lib/deals";
const actor = { id: "person", orgRole: "MEMBER" as const };
const fields = { opportunityType: "RFP_RFA" as const, athenaEntity: "ATHENA_KENYA" as const, netFeeRevenueUsd: 1234.56 };
const existing = { projectId: "deal", workspaceId: "ws", whyPursue: "Purpose", need: null, serviceLine: null, value: null, currency: null, probability: 40, expectedClose: null, introducedBy: null, submissionDeadline: null, createdAt: new Date(), opportunityType: null, athenaEntity: null, netFeeRevenueUsd: null };
const create = { name: "Opportunity", organisationId: "org", pipelineId: "pipe", leaderId: "person", whyPursue: "Purpose", nextStep: { title: "Follow up", dueDate: "2026-11-01" } };
beforeEach(() => {
  vi.clearAllMocks(); m.db.$queryRaw.mockResolvedValue([{pipelineId:"pipe",key:"DEAL_PROACTIVE",stageId:"stage"}]);
  m.db.$transaction.mockImplementation(async (fn) => fn(m.db));
  m.db.user.findUniqueOrThrow.mockResolvedValue({ id: "person", workspaceId: "ws" });
  m.db.user.findUnique.mockResolvedValue({ id: "person", workspaceId: "ws" });
  m.db.pipeline.findFirst.mockResolvedValue({ id: "pipe", key: "DEAL_PROACTIVE", name: "Proactive", stages: [{ id: "stage", requiredFields: [] }] });
  m.db.project.findFirst.mockResolvedValue(null);
  m.db.project.create.mockResolvedValue({ id: "deal", name: "Opportunity" });
  m.db.section.create.mockResolvedValue({ id: "section" });
  m.db.task.create.mockResolvedValue({ id: "first", title: "Follow up" });
  m.db.task.findUnique.mockResolvedValue({ id: "task", projectId: "source", title: "Idea", assigneeId: "person", parentId: null, completedAt: null, deletedAt: null, dueDate: new Date("2026-11-01T00:00:00Z"), collaborators: [] });
  m.db.task.findMany.mockResolvedValue([]); m.db.task.groupBy.mockResolvedValue([]);
  m.db.actionLog.groupBy.mockResolvedValue([]); m.db.note.groupBy.mockResolvedValue([]);
  m.db.dealDetails.findUnique.mockResolvedValue(existing);
  m.db.dealDetails.update.mockImplementation(async ({ data }) => ({ ...existing, ...data, netFeeRevenueUsd: data.netFeeRevenueUsd == null ? data.netFeeRevenueUsd : new Prisma.Decimal(data.netFeeRevenueUsd) }));
  m.access.mockResolvedValue({ project: { id: "deal", typeId: "type_deal" } });
  m.requireWrite.mockImplementation(() => {});
});
describe("SHO-3044 / SHO-3049 additive deal classification API", () => {
  it("accepts all exact classifications on create, convert and update; omitted fields stay optional", () => {
    expect(dealCreate.safeParse(create).success).toBe(true);
    for (const opportunity of OPPORTUNITY_TYPES) for (const entity of ATHENA_ENTITIES) {
      const value = { opportunityType: opportunity.value, athenaEntity: entity.value, netFeeRevenueUsd: 0 };
      expect(dealDetails.parse(value)).toEqual(value);
      expect(dealCreate.parse({ ...create, ...value })).toMatchObject(value);
      expect(taskConvert.parse(value)).toMatchObject(value);
    }
    expect(dealDetails.parse({ opportunityType: null, athenaEntity: null, netFeeRevenueUsd: null })).toEqual({ opportunityType: null, athenaEntity: null, netFeeRevenueUsd: null });
  });
  it("rejects invalid enums, money fractions, negatives, nonfinite and overflowing amounts without rounding", () => {
    for (const netFeeRevenueUsd of [-1, 0.001, 1234.567, NaN, Infinity, -Infinity, 1e13]) expect(netFeeRevenueUsdField.safeParse(netFeeRevenueUsd).success, String(netFeeRevenueUsd)).toBe(false);
    for (const amount of [0, 0.01, 1.1, 1234.56, 9999999999999.99]) expect(netFeeRevenueUsdField.safeParse(amount).success, String(amount)).toBe(true);
    expect(dealDetails.safeParse({ opportunityType: "RFP" }).success).toBe(false);
    expect(dealDetails.safeParse({ athenaEntity: "Athena India" }).success).toBe(false);
    expect(dealDetails.safeParse({ netFeeRevenueUsd: "10.00" }).success).toBe(false);
  });
  it("stores the new fields on creation and includes them in creation audit", async () => {
    await createDeal(actor, { ...create, ...fields });
    expect(m.db.dealDetails.create).toHaveBeenCalledWith({ data: expect.objectContaining(fields) });
    expect(m.log).toHaveBeenCalledWith(m.db, expect.objectContaining({ action: "deal.created", after: expect.objectContaining(fields) }));
  });
  it("stores classification when converting a task without inventing a parallel probability field", async () => {
    m.access.mockResolvedValue({ project: { id: "source", typeId: "type_project" } });
    await convertTaskToDeal(actor, "task", { ...create, ...fields, probability: 75 });
    expect(m.db.dealDetails.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ...fields, probability: 75 }) });
    expect(m.log).toHaveBeenCalledWith(m.db, expect.objectContaining({ action: "deal.converted", after: expect.objectContaining(fields) }));
  });
  it("updates and clears fields through existing authorization and audit", async () => {
    await updateDealDetails(actor, "deal", fields);
    expect(m.access).toHaveBeenCalledWith(actor, "deal", { write: true });
    expect(m.requireWrite).toHaveBeenCalledOnce();
    expect(m.db.dealDetails.update).toHaveBeenCalledWith({ where: { projectId: "deal" }, data: fields });
    expect(m.log).toHaveBeenCalledWith(m.db, expect.objectContaining({ action: "deal.details_updated", before: { opportunityType: null, athenaEntity: null, netFeeRevenueUsd: null }, after: fields }));
    await updateDealDetails(actor, "deal", { opportunityType: null, athenaEntity: null, netFeeRevenueUsd: null });
    expect(m.db.dealDetails.update).toHaveBeenLastCalledWith({ where: { projectId: "deal" }, data: { opportunityType: null, athenaEntity: null, netFeeRevenueUsd: null } });
  });
  it("refuses unauthorised updates before touching details", async () => {
    m.requireWrite.mockImplementation(() => { throw new Error("Read-only"); });
    await expect(updateDealDetails(actor, "deal", fields)).rejects.toThrow("Read-only");
    expect(m.db.dealDetails.update).not.toHaveBeenCalled();
  });
  it("direct domain updates also reject invalid values before a write", async () => {
    await expect(updateDealDetails(actor, "deal", { netFeeRevenueUsd: 1.001 })).rejects.toMatchObject({ status: 400 });
    expect(m.db.dealDetails.update).not.toHaveBeenCalled();
  });
  it("serializes Decimal revenue as a JSON number and unknown legacy fields as null", async () => {
    const project = { id: "deal", typeId: "type_deal", name: "Deal", createdAt: new Date(), stageChangedAt: null, archivedAt: null, stage: null, pipeline: null, stageReason: null, parties: [], members: [], deal: { ...existing, ...fields, netFeeRevenueUsd: new Prisma.Decimal("1234.56") } };
    m.db.project.findUnique.mockResolvedValue(project); m.db.project.findMany.mockResolvedValue([project]);
    expect((await dealBlock("deal"))?.details).toMatchObject(fields);
    expect((await listDeals(actor))[0]).toMatchObject({ ...fields, probability: 40 });
    m.db.project.findUnique.mockResolvedValue({ ...project, deal: { ...existing } });
    expect((await dealBlock("deal"))?.details).toMatchObject({ opportunityType: null, athenaEntity: null, netFeeRevenueUsd: null });
  });
});
it.each(['probability','netFeeRevenueUsd','athenaEntity'])('3049 blocks direct clearing %s at Submitted before update/audit', async key => {
  m.db.$queryRaw.mockResolvedValue([{pipelineId:'bid',key:'DEAL_BID',stageId:'st_bid_submitted'}]);
  m.db.dealDetails.findUnique.mockResolvedValue({...existing,probability:0,netFeeRevenueUsd:0,athenaEntity:'ATHENA_INDIA'});
  await expect(updateDealDetails(actor,'deal',{[key]:null})).rejects.toMatchObject({status:409});
  expect(m.db.dealDetails.update).not.toHaveBeenCalled(); expect(m.log).not.toHaveBeenCalled();
});
it('3049 rejects create or task conversion directly into a configured Submitted first stage without required fields', async () => {
  m.db.pipeline.findFirst.mockResolvedValue({id:'bid',key:'DEAL_BID',stages:[{id:'st_bid_submitted',requiredFields:[]}]});
  await expect(createDeal(actor,{...create,submissionDeadline:'2026-11-01'})).rejects.toMatchObject({status:409});
  m.access.mockResolvedValue({project:{id:'source',typeId:'normal'}});
  await expect(convertTaskToDeal(actor,'task',{...create,submissionDeadline:'2026-11-01',dueDate:'2026-11-02'})).rejects.toMatchObject({status:409});
  expect(m.db.project.create).not.toHaveBeenCalled(); expect(m.db.task.update).not.toHaveBeenCalled();
});
it('3049 still permits incomplete Bid Leads drafts', async () => {
  m.db.pipeline.findFirst.mockResolvedValue({id:'bid',key:'DEAL_BID',stages:[{id:'st_bid_identified',requiredFields:[]}]});
  await createDeal(actor,{...create,submissionDeadline:'2026-11-01'});
  expect(m.db.project.create).toHaveBeenCalledOnce();
});
