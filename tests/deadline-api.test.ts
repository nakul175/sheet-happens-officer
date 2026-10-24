import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { dealCreate, dealDetails, taskConvert } from "@/lib/schemas";
const m = vi.hoisted(() => ({ db: { $queryRaw: vi.fn(), user: { findUniqueOrThrow: vi.fn(), findUnique: vi.fn() }, pipeline: { findFirst: vi.fn() }, project: { findFirst: vi.fn(), create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn() }, projectMember: { create: vi.fn() }, section: { create: vi.fn() }, dealDetails: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() }, dealParty: { create: vi.fn() }, task: { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), groupBy: vi.fn(), update: vi.fn() }, actionLog: { groupBy: vi.fn(), findUnique: vi.fn(), update: vi.fn() }, note: { groupBy: vi.fn() }, taskCollaborator: { deleteMany: vi.fn() }, $transaction: vi.fn() }, access: vi.fn(), requireWrite: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: m.db }));
vi.mock("@/lib/access", () => ({ isActive: () => true, isAdmin: () => false, projectAccess: m.access, requireWrite: m.requireWrite }));
vi.mock("@/lib/notify", () => ({ auditTx: vi.fn(), logAction: m.log, notify: vi.fn() }));
vi.mock("@/lib/orgs", () => ({ orgOf: async () => ({ id: "org", name: "Buyer", archivedAt: null }) }));
vi.mock("@/lib/tasks", () => ({ taskAccess: m.access, recordAccess: m.access }));
vi.mock("@/lib/crm", () => ({ WORKSTREAM_DEAL: "type_deal", requireCrm: vi.fn(), crmMode: () => "on", crmVisible: () => true, crmProjectWhere: () => ({}) }));
vi.mock("@/lib/records", () => ({ undoRecord: vi.fn() }));
vi.mock("@/lib/comments", () => ({ assertCommentRoom: vi.fn() }));
import { undoAction } from "@/lib/undo";
import { createDeal, convertTaskToDeal, updateDealDetails, listDeals, dealBlock } from "@/lib/deals";
const actor = { id: "person", orgRole: "MEMBER" as const };
const existing = { projectId: "deal", workspaceId: "ws", whyPursue: "Purpose", need: null, serviceLine: null, value: null, currency: null, probability: 40, expectedClose: null, introducedBy: null, submissionDeadline: null, submissionDeadlineHasTime: false, createdAt: new Date(), opportunityType: null, athenaEntity: null, netFeeRevenueUsd: null };
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

describe("SHO-3054 API submission deadline precision", () => {
  const timed="2026-10-25T05:30:00+05:30";
  const stored=new Date("2026-10-25T00:00:00.000Z");
  it("validates timed/date/null payloads in create, update and conversion",()=>{
    for(const submissionDeadline of [timed,"2026-10-25",null]){
      expect(dealDetails.safeParse({submissionDeadline}).success).toBe(true);
      expect(dealCreate.safeParse({...create,submissionDeadline}).success).toBe(true);
      expect(taskConvert.safeParse({submissionDeadline}).success).toBe(true);
    }
    for(const submissionDeadline of ["2026-02-29","2026-10-25T10:00", "2026-10-25T24:00:00Z"]){expect(dealDetails.safeParse({submissionDeadline}).success).toBe(false);}
  });
  it("create and conversion store exact instant/precision and canonical creation audit",async()=>{
    await createDeal(actor,{...create,submissionDeadline:timed});
    expect(m.db.dealDetails.create).toHaveBeenLastCalledWith({data:expect.objectContaining({submissionDeadline:stored,submissionDeadlineHasTime:true})});
    expect(m.log).toHaveBeenCalledWith(m.db,expect.objectContaining({action:"deal.created",after:expect.objectContaining({submissionDeadline:stored.toISOString(),submissionDeadlineHasTime:true})}));
    m.access.mockResolvedValue({project:{id:"source",typeId:"type_project"}});
    await convertTaskToDeal(actor,"task",{...create,submissionDeadline:timed});
    expect(m.db.dealDetails.create).toHaveBeenLastCalledWith({data:expect.objectContaining({submissionDeadline:stored,submissionDeadlineHasTime:true})});
    expect(m.log).toHaveBeenCalledWith(m.db,expect.objectContaining({action:"deal.converted",after:expect.objectContaining({submissionDeadline:stored.toISOString(),submissionDeadlineHasTime:true})}));
  });
  it("update audits exact deadline and precision; omitted patch preserves them and clear resets both",async()=>{
    await updateDealDetails(actor,"deal",{submissionDeadline:timed});
    expect(m.db.dealDetails.update).toHaveBeenLastCalledWith({where:{projectId:"deal"},data:{submissionDeadline:stored,submissionDeadlineHasTime:true}});
    expect(m.log).toHaveBeenCalledWith(m.db,expect.objectContaining({before:{submissionDeadline:null,submissionDeadlineHasTime:false},after:{submissionDeadline:stored.toISOString(),submissionDeadlineHasTime:true}}));
    await updateDealDetails(actor,"deal",{submissionDeadline:null});
    expect(m.db.dealDetails.update).toHaveBeenLastCalledWith({where:{projectId:"deal"},data:{submissionDeadline:null,submissionDeadlineHasTime:false}});
    await updateDealDetails(actor,"deal",{submissionDeadline:"2026-10-25"});
    expect(m.db.dealDetails.update).toHaveBeenLastCalledWith({where:{projectId:"deal"},data:{submissionDeadline:stored,submissionDeadlineHasTime:false}});
    m.db.dealDetails.update.mockClear();await updateDealDetails(actor,"deal",{});expect(m.db.dealDetails.update).not.toHaveBeenCalled();
  });
  it("list and detail preserve date-only strings but serialize explicit05:30 as UTC ISO+flag",async()=>{
    for(const flag of [false,true]){
      const project={id:"deal",typeId:"type_deal",name:"Deal",createdAt:new Date(),stageChangedAt:null,archivedAt:null,stage:null,pipeline:null,stageReason:null,parties:[],members:[],deal:{...existing,submissionDeadline:stored,submissionDeadlineHasTime:flag}};
      m.db.project.findUnique.mockResolvedValue(project);m.db.project.findMany.mockResolvedValue([project]);
      const expected={submissionDeadline:flag?stored.toISOString():"2026-10-25",submissionDeadlineHasTime:flag};
      expect((await dealBlock("deal"))?.details).toMatchObject(expected);expect((await listDeals(actor))[0]).toMatchObject(expected);
    }
  });
  it("direct invalid domain calls are rejected without a write",async()=>{await expect(updateDealDetails(actor,"deal",{submissionDeadline:"2026-04-31T12:00:00Z"})).rejects.toMatchObject({status:400});expect(m.db.dealDetails.update).not.toHaveBeenCalled();});
  it("Undo restores exact timestamp and precision flag instead of concatenating date-only midnight",async()=>{
    const before={submissionDeadline:stored.toISOString(),submissionDeadlineHasTime:true};const after={submissionDeadline:"2026-10-26",submissionDeadlineHasTime:false};
    m.db.actionLog.findUnique.mockResolvedValue({id:"log",projectId:"deal",targetId:"deal",targetType:"deal",action:"deal.details_updated",actorId:actor.id,createdAt:new Date(),undoneAt:null,beforeState:before,afterState:after});
    m.db.dealDetails.findUnique.mockResolvedValue({...existing,submissionDeadline:new Date("2026-10-26T00:00:00Z"),submissionDeadlineHasTime:false});
    await undoAction(actor,"log");
    expect(m.db.dealDetails.update).toHaveBeenCalledWith({where:{projectId:"deal"},data:{submissionDeadline:stored,submissionDeadlineHasTime:true}});
  });
});
it('3049 Undo cannot remove required PWin from an already submitted deal',async()=>{
  m.db.$queryRaw.mockResolvedValue([{pipelineId:'bid',key:'DEAL_BID',stageId:'st_bid_submitted'}]);
  m.db.actionLog.findUnique.mockResolvedValue({id:'log',projectId:'deal',targetId:'deal',targetType:'deal',action:'deal.details_updated',actorId:actor.id,createdAt:new Date(),undoneAt:null,beforeState:{probability:null},afterState:{probability:0}});
  m.db.dealDetails.findUnique.mockResolvedValue({...existing,probability:0,netFeeRevenueUsd:0,athenaEntity:'ATHENA_INDIA'});
  await expect(undoAction(actor,'log')).rejects.toMatchObject({status:409});
  expect(m.db.dealDetails.update).not.toHaveBeenCalled();expect(m.db.actionLog.update).not.toHaveBeenCalled();
});
