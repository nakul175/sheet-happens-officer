import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ db: { stage: { findFirst: vi.fn(), findUnique: vi.fn() }, pipeline: { findUnique: vi.fn(), findMany: vi.fn() }, project: { update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn(), findUniqueOrThrow: vi.fn() }, task: { findMany: vi.fn(), groupBy: vi.fn() }, dealDetails: { findUnique: vi.fn() }, actionLog: { groupBy: vi.fn(), findUnique: vi.fn(), update: vi.fn() }, note: { groupBy: vi.fn() }, $transaction: vi.fn() }, access: vi.fn(), write: vi.fn(), notify: vi.fn(), log: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: m.db }));
vi.mock("@/lib/access", () => ({ projectAccess: m.access, requireWrite: m.write, isActive: () => true, isAdmin: () => false }));
vi.mock("@/lib/crm", () => ({ WORKSTREAM_DEAL: "wst_deal", requireCrm: () => {}, crmMode: () => "all", crmVisible: () => true, crmProjectWhere: () => ({}) }));
vi.mock("@/lib/notify", () => ({ notify: m.notify, logAction: m.log, auditTx: m.audit }));
vi.mock("@/lib/orgs", () => ({ orgOf: vi.fn() }));
vi.mock("@/lib/tasks", () => ({ taskAccess: vi.fn(), recordAccess: m.access }));
vi.mock("@/lib/records", () => ({ undoRecord: vi.fn() }));
vi.mock("@/lib/comments", () => ({ assertCommentRoom: vi.fn() }));
import { listDeals } from "@/lib/deals";
const user = { id: "me", orgRole: "MEMBER" as const };
const access = () => ({ role: "LEADER", project: { id: "deal", typeId: "wst_deal", pipelineId: "pl_bid", stageId: "st_bid_won", members: [{ role: "LEADER", userId: "me" }] } });
const delivery = { id: "st_bid_ongoing", name: "Ongoing Projects", category: "DELIVERY", isRetired: false, requiredFields: [], needsReason: false };
beforeEach(() => { vi.resetAllMocks(); m.access.mockResolvedValue(access()); m.db.stage.findFirst.mockResolvedValue(delivery); m.db.stage.findUnique.mockResolvedValue({ id: "st_bid_won", category: "DONE" }); m.db.pipeline.findUnique.mockResolvedValue({ key: "DEAL_BID" }); m.db.dealDetails.findUnique.mockResolvedValue({}); m.db.$transaction.mockImplementation(async (fn) => fn(m.db)); m.db.project.updateMany.mockResolvedValue({ count: 1 }); m.db.task.findMany.mockResolvedValue([]); m.db.task.groupBy.mockResolvedValue([]); m.db.actionLog.groupBy.mockResolvedValue([]); m.db.note.groupBy.mockResolvedValue([]); });

it("combines date range with privacy, pipeline, lifecycle, archived and mine scopes using AND",async()=>{
 m.db.project.findMany.mockResolvedValue([]);
 await listDeals(user,{dateFilter:{basis:"submissionDeadline",from:"2026-10-25",to:"2026-10-25",includeUndated:true},lifecycle:"sales",mine:true,archived:true,pipelineId:"pl_bid"});
 const where=m.db.project.findMany.mock.calls[0][0].where;
 expect(where).toMatchObject({typeId:"wst_deal",members:{some:{userId:"me"}},pipelineId:"pl_bid",archivedAt:{not:null},OR:[{stageId:null},{stage:{category:{not:"DELIVERY"}}}]});
 expect(where.AND).toHaveLength(2);expect(where.AND[0]).toMatchObject({OR:[{members:{some:{userId:"me",role:"LEADER"}}},{tasks:{some:{assigneeId:"me",deletedAt:null,completedAt:null}}}]});
 expect(where.AND[1].OR).toHaveLength(3);expect(where.AND[1].OR[0].deal.is.OR).toHaveLength(2);
});
it("delivery filter intersects created-date bounds without removing membership restrictions",async()=>{
 m.db.project.findMany.mockResolvedValue([]);await listDeals(user,{dateFilter:{basis:"createdAt",from:"2026-10-25",includeUndated:false},lifecycle:"delivery"});
 expect(m.db.project.findMany.mock.calls[0][0].where).toMatchObject({members:{some:{userId:"me"}},stage:{category:"DELIVERY"},AND:[{createdAt:{gte:new Date("2026-10-24T18:30:00.000Z")}}]});
});
it("invalid direct domain ranges return400 before any query",async()=>{
 await expect(listDeals(user,{dateFilter:{basis:"createdAt",from:"2026-10-26",to:"2026-10-25",includeUndated:false}})).rejects.toMatchObject({status:400});expect(m.db.project.findMany).not.toHaveBeenCalled();
});
it("default request has no extra date predicate and adds read-only created/close dates",async()=>{
 const date=new Date("2026-10-24T19:00:00Z");m.db.project.findMany.mockResolvedValue([{id:"deal",name:"Deal",createdAt:date,stageChangedAt:date,stage:null,pipeline:null,members:[],parties:[],deal:{value:null,expectedClose:new Date("2026-10-26T00:00:00Z")}}]);
 expect(await listDeals(user)).toMatchObject([{createdAt:"2026-10-24T19:00:00.000Z",expectedClose:"2026-10-26"}]);const where=m.db.project.findMany.mock.calls[0][0].where;expect(where.AND).toBeUndefined();expect(where.createdAt).toBeUndefined();
});
