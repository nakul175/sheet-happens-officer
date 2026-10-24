import { beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({ access:vi.fn(), db:{ user:{findUnique:vi.fn()}, $transaction:vi.fn() }, tx:{projectMember:{create:vi.fn()}}, notify:vi.fn(),log:vi.fn() }));
vi.mock("@/lib/db",()=>({db:m.db}));
vi.mock("@/lib/access",async original=>({...await original<typeof import("@/lib/access")>(),projectAccess:m.access}));
vi.mock("@/lib/notify",()=>({notify:m.notify,logAction:m.log}));
vi.mock("@/lib/people",()=>({openTaskCount:vi.fn(),releasePerson:vi.fn(),resolveHandover:vi.fn()}));
vi.mock("@/lib/deals",()=>({dealBlock:vi.fn()}));
import {addMember} from "@/lib/projects";
const actor={id:"leader",orgRole:"MEMBER" as const};
const access={role:"LEADER",project:{id:"project",workspaceId:"own-workspace",name:"Own project",members:[]}};
const active={id:"target",workspaceId:"own-workspace",emailVerifiedAt:new Date("2026-10-24"),deactivatedAt:null};
beforeEach(()=>{vi.resetAllMocks();m.access.mockResolvedValue(access);m.db.user.findUnique.mockResolvedValue(active);m.db.$transaction.mockImplementation(async fn=>fn(m.tx));});
describe("legacy Members API preserves workspace boundary",()=>{
 it.each(["EDITOR","VIEWER"] as const)("allows active same-workspace person with requested existing %s role",async role=>{
  await addMember(actor,"project","target",role);
  expect(m.tx.projectMember.create).toHaveBeenCalledWith({data:{projectId:"project",userId:"target",role}});
  expect(m.notify).toHaveBeenCalledWith(m.tx,["target"],"ADDED_TO_PROJECT",expect.objectContaining({projectId:"project",data:{project:"Own project",role}}));
  expect(m.log).toHaveBeenCalledWith(m.tx,expect.objectContaining({action:"member.added",after:{role}}));
 });
 it("refuses an active person from another workspace without writes or notices",async()=>{
  m.db.user.findUnique.mockResolvedValue({...active,workspaceId:"other-workspace"});
  await expect(addMember(actor,"project","target","EDITOR")).rejects.toMatchObject({status:400});
  expect(m.db.$transaction).not.toHaveBeenCalled();expect(m.tx.projectMember.create).not.toHaveBeenCalled();expect(m.notify).not.toHaveBeenCalled();expect(m.log).not.toHaveBeenCalled();
 });
 it.each([null,{...active,deactivatedAt:new Date()},{...active,emailVerifiedAt:null}])("refuses missing/inactive/unverified people without writes (%j)",async person=>{
  m.db.user.findUnique.mockResolvedValue(person);
  await expect(addMember(actor,"project","target","VIEWER")).rejects.toMatchObject({status:400});
  expect(m.db.$transaction).not.toHaveBeenCalled();expect(m.tx.projectMember.create).not.toHaveBeenCalled();
 });
 it("preserves existing member role and duplicate409",async()=>{
  m.access.mockResolvedValue({...access,project:{...access.project,members:[{userId:"target",role:"VIEWER"}]}});
  await expect(addMember(actor,"project","target","EDITOR")).rejects.toMatchObject({status:409});expect(m.tx.projectMember.create).not.toHaveBeenCalled();
 });
 it.each(["EDITOR","VIEWER"])("keeps %s callers unable to add people",async role=>{
  m.access.mockResolvedValue({...access,role});await expect(addMember(actor,"project","target","EDITOR")).rejects.toMatchObject({status:403});expect(m.db.user.findUnique).not.toHaveBeenCalled();expect(m.tx.projectMember.create).not.toHaveBeenCalled();
 });
 it("retains outsider404 before looking up any target",async()=>{
  m.access.mockRejectedValue({status:404});await expect(addMember(actor,"project","target","VIEWER")).rejects.toMatchObject({status:404});expect(m.db.user.findUnique).not.toHaveBeenCalled();
 });
});
