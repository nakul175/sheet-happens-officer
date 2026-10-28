import { beforeEach, describe, expect, it, vi } from "vitest";
const m=vi.hoisted(()=>({ access:vi.fn(), db:{user:{findUnique:vi.fn(),findMany:vi.fn()},task:{findUnique:vi.fn()},actionLog:{findFirst:vi.fn()},$transaction:vi.fn()},tx:{$queryRaw:vi.fn(),user:{findUnique:vi.fn(),findFirst:vi.fn()},projectMember:{findUnique:vi.fn(),createMany:vi.fn()},task:{findUnique:vi.fn(),update:vi.fn(),create:vi.fn()},section:{findFirst:vi.fn()},taskCollaborator:{create:vi.fn()}},notify:vi.fn(),log:vi.fn(),targetRole:null as string|null,actorRole:"LEADER",actorOrgRole:"MEMBER",workspace:"ws",targetActive:true,failWrite:false}));
vi.mock("@/lib/db",()=>({db:m.db}));
vi.mock("@/lib/access",async original=>({...await original<typeof import("@/lib/access")>(),projectAccess:m.access}));
vi.mock("@/lib/notify",()=>({notify:m.notify,logAction:m.log,auditTx:vi.fn()}));
vi.mock("@/lib/deals",()=>({ensureNextStep:vi.fn()}));
vi.mock("@/lib/records",()=>({linksOfTask:vi.fn()}));
import { addWorkspaceTaskMember, workspaceTaskPeople } from "@/lib/project-task-membership";
import { assignTask, addCollaborator, createTask } from "@/lib/tasks";
import type { Tx } from "@/lib/access";
const actor={id:"actor",orgRole:"MEMBER" as const},version="2026-10-25T00:00:00.000Z";
const person=(id:string)=>({id,workspaceId:m.workspace,orgRole:m.actorOrgRole,deactivatedAt:null,emailVerifiedAt:new Date(0),name:id});
const task=()=>({id:"task",projectId:"project",parentId:null,assigneeId:"actor",approverId:null,previousAssigneeId:null,createdById:"actor",title:"Task",priority:"MEDIUM",description:null,dueDate:null,blocked:false,blockedReason:null,completedAt:null,deletedAt:null,updatedAt:new Date(version),assignee:{id:"actor",name:"Actor"},approver:null,collaborators:[],subtasks:[]});
beforeEach(()=>{
 vi.clearAllMocks();m.actorRole="LEADER";m.actorOrgRole="MEMBER";m.workspace="ws";m.targetRole=null;m.targetActive=true;m.failWrite=false;
 m.access.mockResolvedValue({role:"LEADER",admin:false,project:{id:"project",workspaceId:"ws",archivedAt:null,members:[{userId:"actor",role:"LEADER"}]}});
 m.tx.$queryRaw.mockResolvedValue([{id:"project",workspaceId:"ws",name:"Private project",archivedAt:null}]);
 m.tx.user.findUnique.mockImplementation(async()=>person("actor"));m.db.user.findUnique.mockImplementation(async()=>person("actor"));
 m.tx.user.findFirst.mockImplementation(async()=>m.targetActive?{id:"target"}:null);
 m.tx.projectMember.findUnique.mockImplementation(async({where})=>where.projectId_userId.userId==="actor"?{role:m.actorRole,user:person("actor")}:(m.targetRole?{role:m.targetRole,user:person("target")}:null));
 m.tx.projectMember.createMany.mockImplementation(async()=>{if(m.targetRole)return{count:0};m.targetRole="EDITOR";return{count:1};});
 m.tx.section.findFirst.mockResolvedValue({id:"section",isDone:false});m.tx.task.create.mockResolvedValue({id:"created",title:"New"});
 m.db.task.findUnique.mockImplementation(async()=>task());m.tx.task.findUnique.mockImplementation(async()=>task());m.db.actionLog.findFirst.mockResolvedValue(null);
 m.tx.task.update.mockImplementation(async()=>{if(m.failWrite)throw Error("task write failed");return{updatedAt:new Date(version)};});
 m.db.$transaction.mockImplementation(async fn=>{const before=m.targetRole;try{return await fn(m.tx);}catch(error){m.targetRole=before;throw error;}});
});
describe("SHO3058 explicit workspace membership for task actions",()=>{
 it("atomic assign grants Editor membership, sends ordinary notices/audits, and returns task version",async()=>{
  await assignTask(actor,"task","target",version,true);expect(m.targetRole).toBe("EDITOR");expect(m.tx.projectMember.createMany).toHaveBeenCalledWith({data:[{projectId:"project",userId:"target",role:"EDITOR"}],skipDuplicates:true});
  expect(m.log).toHaveBeenCalledWith(m.tx,expect.objectContaining({action:"member.added",primary:false}));expect(m.log).toHaveBeenCalledWith(m.tx,expect.objectContaining({action:"task.assigned",before:expect.objectContaining({assigneeId:"actor"}),after:expect.objectContaining({assigneeId:"target"})}));expect(m.notify).toHaveBeenCalledWith(m.tx,["target"],"ADDED_TO_PROJECT",expect.any(Object));expect(m.notify).toHaveBeenCalledWith(m.tx,["target"],"TASK_ASSIGNED",expect.any(Object));
 });
 it("rolls membership back when task write fails",async()=>{m.failWrite=true;await expect(assignTask(actor,"task","target",version,true)).rejects.toThrow("task write failed");expect(m.targetRole).toBe(null);});
 it("without explicit confirmation a nonmember remains ineligible and no membership is created",async()=>{await expect(assignTask(actor,"task","target",version)).rejects.toMatchObject({status:400});expect(m.tx.projectMember.createMany).not.toHaveBeenCalled();expect(m.targetRole).toBe(null);});
 it("retains an existing Viewer and refuses assignment without promoting them",async()=>{m.targetRole="VIEWER";await expect(assignTask(actor,"task","target",version,true)).rejects.toMatchObject({status:400});expect(m.targetRole).toBe("VIEWER");expect(m.tx.task.update).not.toHaveBeenCalled();expect(m.log).not.toHaveBeenCalledWith(m.tx,expect.objectContaining({action:"member.added"}));});
 it("concurrent/already-existing Editor membership does not duplicate membership notices or logs",async()=>{m.targetRole="EDITOR";await assignTask(actor,"task","target",version,true);expect(m.notify).not.toHaveBeenCalledWith(m.tx,["target"],"ADDED_TO_PROJECT",expect.any(Object));expect(m.log).not.toHaveBeenCalledWith(m.tx,expect.objectContaining({action:"member.added"}));});
 it("Editor/Viewer caller and lost Leader authority cannot grant project access",async()=>{
  m.access.mockResolvedValue({role:"EDITOR",project:{id:"project",workspaceId:"ws"}});await expect(assignTask(actor,"task","target",version,true)).rejects.toMatchObject({status:403});expect(m.tx.projectMember.createMany).not.toHaveBeenCalled();
  m.access.mockResolvedValue({role:"LEADER",project:{id:"project",workspaceId:"ws"}});m.actorRole="EDITOR";await expect(assignTask(actor,"task","target",version,true)).rejects.toMatchObject({status:403});expect(m.tx.projectMember.createMany).not.toHaveBeenCalled();
 });
 it("cross-workspace actor/target and inactive person are refused before membership write",async()=>{
  m.workspace="other";await expect(addWorkspaceTaskMember(m.tx as unknown as Tx,actor,"project","target")).rejects.toMatchObject({status:404});m.workspace="ws";m.targetActive=false;await expect(addWorkspaceTaskMember(m.tx as unknown as Tx,actor,"project","target")).rejects.toMatchObject({status:400});expect(m.tx.projectMember.createMany).not.toHaveBeenCalled();expect(m.tx.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({workspaceId:"ws",deactivatedAt:null,emailVerifiedAt:{not:null}})}));
 });
 it("stale task version rolls newly granted membership back",async()=>{m.tx.task.findUnique.mockResolvedValue({...task(),updatedAt:new Date("2026-10-26T00:00:00Z")});await expect(assignTask(actor,"task","target",version,true)).rejects.toMatchObject({status:409});expect(m.targetRole).toBe(null);expect(m.tx.task.update).not.toHaveBeenCalled();});
 it("collaborator grant shares atomic membership and requires a version for the explicit grant",async()=>{
  await expect(addCollaborator(actor,"task","target",{addToProject:true})).rejects.toMatchObject({status:400});expect(m.tx.projectMember.createMany).not.toHaveBeenCalled();
  await addCollaborator(actor,"task","target",{addToProject:true,expectedUpdatedAt:version});expect(m.tx.taskCollaborator.create).toHaveBeenCalledWith({data:{taskId:"task",userId:"target"}});expect(m.log).toHaveBeenCalledWith(m.tx,expect.objectContaining({action:"task.collaborator_added"}));
 });
 it("creation adds the explicitly confirmed assignee in its task transaction",async()=>{
  await createTask(actor,"project",{title:"New",sectionId:"section",assigneeId:"target",addAssigneeToProject:true});
  expect(m.tx.task.create).toHaveBeenCalledWith({data:expect.objectContaining({assigneeId:"target",collaborators:{create:[]}})});expect(m.targetRole).toBe("EDITOR");
 });
 it("creation adds explicitly confirmed collaborators without changing the default creator owner",async()=>{
  await createTask(actor,"project",{title:"New",sectionId:"section",collaboratorIds:["target"],addCollaboratorsToProject:["target"]});
  expect(m.tx.task.create).toHaveBeenCalledWith({data:expect.objectContaining({assigneeId:"actor",collaborators:{create:[{userId:"target"}]}})});expect(m.targetRole).toBe("EDITOR");
 });
 it("creation refuses unconfirmed nonmembers and unmatched membership grants",async()=>{
  await expect(createTask(actor,"project",{title:"New",sectionId:"section",assigneeId:"target"})).rejects.toMatchObject({status:400});expect(m.tx.projectMember.createMany).not.toHaveBeenCalled();
  await expect(createTask(actor,"project",{title:"New",sectionId:"section",assigneeId:"actor",addCollaboratorsToProject:["target"]})).rejects.toMatchObject({status:400});expect(m.tx.task.create).not.toHaveBeenCalled();
 });
 it("locked collaborator snapshot detects a concurrent duplicate despite unchanged task version",async()=>{
  m.tx.task.findUnique.mockResolvedValue({...task(),collaborators:[{user:{id:"target",name:"Target"}}]});
  await expect(addCollaborator(actor,"task","target",{addToProject:true,expectedUpdatedAt:version})).rejects.toMatchObject({status:409});expect(m.tx.taskCollaborator.create).not.toHaveBeenCalled();expect(m.targetRole).toBe(null);
 });
 it("unique collaborator insertion races return409 and roll back membership",async()=>{
  m.tx.taskCollaborator.create.mockRejectedValueOnce({code:"P2002"});
  await expect(addCollaborator(actor,"task","target",{addToProject:true,expectedUpdatedAt:version})).rejects.toMatchObject({status:409});expect(m.targetRole).toBe(null);
 });
 it("workspace search requires manager access and exposes names/current membership only",async()=>{
  m.db.user.findMany.mockResolvedValue([{id:"target",name:"Target",memberships:[]}]);expect(await workspaceTaskPeople(actor,"project","ta","assignee")).toEqual([{id:"target",name:"Target",isMember:false}]);
  expect(m.db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({workspaceId:"ws",deactivatedAt:null,emailVerifiedAt:{not:null},NOT:{memberships:{some:{projectId:"project",role:"VIEWER"}}}}),select:{id:true,name:true,memberships:{where:{projectId:"project"},select:{role:true}}},take:20}));
  m.access.mockResolvedValue({role:"EDITOR",project:{workspaceId:"ws"}});await expect(workspaceTaskPeople(actor,"project","ta","assignee")).rejects.toMatchObject({status:403});
 });
});
