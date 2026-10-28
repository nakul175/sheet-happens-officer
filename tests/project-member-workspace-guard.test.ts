import { beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({ access:vi.fn(), db:{ user:{findUnique:vi.fn(),findUniqueOrThrow:vi.fn(),findMany:vi.fn()}, $transaction:vi.fn() }, tx:{projectMember:{create:vi.fn()},project:{create:vi.fn()},section:{create:vi.fn()}}, notify:vi.fn(),log:vi.fn() }));
vi.mock("@/lib/db",()=>({db:m.db}));
vi.mock("@/lib/access",async original=>({...await original<typeof import("@/lib/access")>(),projectAccess:m.access}));
vi.mock("@/lib/notify",()=>({notify:m.notify,logAction:m.log}));
vi.mock("@/lib/people",()=>({openTaskCount:vi.fn(),releasePerson:vi.fn(),resolveHandover:vi.fn()}));
vi.mock("@/lib/deals",()=>({dealBlock:vi.fn()}));
import {addMember,createProject} from "@/lib/projects";
const actor={id:"leader",orgRole:"MEMBER" as const};
const access={role:"LEADER",project:{id:"project",workspaceId:"own-workspace",name:"Own project",members:[]}};
const active={id:"target",workspaceId:"own-workspace",emailVerifiedAt:new Date("2026-10-24"),deactivatedAt:null};
beforeEach(()=>{vi.resetAllMocks();m.access.mockResolvedValue(access);m.db.user.findUnique.mockResolvedValue(active);m.db.user.findUniqueOrThrow.mockResolvedValue({id:actor.id,workspaceId:"own-workspace"});m.db.user.findMany.mockResolvedValue([]);m.tx.project.create.mockResolvedValue({id:"new-project",name:"New project"});m.db.$transaction.mockImplementation(async fn=>fn(m.tx));});
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

describe("project creation workspace membership boundary",()=>{
 it("refuses a foreign active Leader before creating any project or membership",async()=>{
  m.db.user.findUnique.mockResolvedValue({...active,workspaceId:"other-workspace"});
  await expect(createProject(actor,{name:"New project",leaderId:"target"})).rejects.toMatchObject({status:400});
  expect(m.tx.project.create).not.toHaveBeenCalled();expect(m.tx.projectMember.create).not.toHaveBeenCalled();expect(m.notify).not.toHaveBeenCalled();
 });
 it("refuses a foreign initial member before creating any project or membership",async()=>{
  m.db.user.findMany.mockResolvedValue([{...active,id:"initial",workspaceId:"other-workspace"}]);
  await expect(createProject(actor,{name:"New project",leaderId:"target",members:[{userId:"initial",role:"VIEWER"}]})).rejects.toMatchObject({status:400});
  expect(m.tx.project.create).not.toHaveBeenCalled();expect(m.tx.projectMember.create).not.toHaveBeenCalled();expect(m.notify).not.toHaveBeenCalled();
 });
 it("preserves same-workspace leader, creator and explicitly requested initial member roles",async()=>{
  m.db.user.findMany.mockResolvedValue([{...active,id:"editor"},{...active,id:"viewer"}]);
  await expect(createProject(actor,{name:"New project",leaderId:"target",members:[{userId:"editor",role:"EDITOR"},{userId:"viewer",role:"VIEWER"}]})).resolves.toMatchObject({id:"new-project"});
  expect(m.tx.project.create).toHaveBeenCalledWith({data:{workspaceId:"own-workspace",name:"New project",description:null}});
  for(const [userId,role] of [["target","LEADER"],["leader","EDITOR"],["editor","EDITOR"],["viewer","VIEWER"]])expect(m.tx.projectMember.create).toHaveBeenCalledWith({data:{projectId:"new-project",userId,role}});
 });
 it.each([null,{...active,deactivatedAt:new Date()},{...active,emailVerifiedAt:null}])("refuses missing/inactive/unverified leader (%j)",async person=>{
  m.db.user.findUnique.mockResolvedValue(person);await expect(createProject(actor,{name:"New project",leaderId:"target"})).rejects.toMatchObject({status:400});expect(m.tx.project.create).not.toHaveBeenCalled();
 });
 it.each([{people:[]},{people:[{...active,id:"initial",deactivatedAt:new Date()}]},{people:[{...active,id:"initial",emailVerifiedAt:null}]}])("refuses missing/inactive/unverified initial member (%j)",async ({people})=>{
  m.db.user.findMany.mockResolvedValue(people);await expect(createProject(actor,{name:"New project",leaderId:"target",members:[{userId:"initial",role:"EDITOR"}]})).rejects.toMatchObject({status:400});expect(m.tx.project.create).not.toHaveBeenCalled();
 });
});
