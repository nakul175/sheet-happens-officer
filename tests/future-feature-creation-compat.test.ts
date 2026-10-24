// Actual HTTP + PostgreSQL integration of the approved creation-only policy.
import { afterAll, beforeAll, expect, it } from "vitest";
import { account, BASE, zzProject, type Account } from "./helpers";
import { db } from "../src/lib/db";
import { newTurn, runTool } from "../src/lib/concierge/tools";
import { assertCreationCompatTarget } from "./future-feature-creation-target";
const people:Account[]=[], projects:string[]=[];
beforeAll(() => assertCreationCompatTarget(process.env, BASE));
afterAll(async()=>{ // This file creates only its own IDs in a separately provisioned local schema.
 assertCreationCompatTarget(process.env, BASE);
 const ids=people.map(p=>p.id);
 await db.actionLog.deleteMany({where:{actorId:{in:ids}}});await db.notification.deleteMany({where:{recipientId:{in:ids}}});
 await db.task.deleteMany({where:{projectId:{in:projects}}});await db.section.deleteMany({where:{projectId:{in:projects}}});await db.projectMember.deleteMany({where:{projectId:{in:projects}}});await db.project.deleteMany({where:{id:{in:projects}}});
 await db.session.deleteMany({where:{userId:{in:ids}}});await db.authToken.deleteMany({where:{userId:{in:ids}}});await db.user.deleteMany({where:{id:{in:ids}}});await db.$disconnect();
});
it("Project creation rejects missing dates without writes; Ideas/subtasks and legacy edits retain explicit exceptions",async()=>{
 const a=await account(`ZZ-TEST policy ${Date.now()}`, `nakul17+zz-future-policy-${Date.now()}@aplyd.com`);people.push(a);const p=await zzProject(a,"future policy");projects.push(p);
 const endpoint=`/api/projects/${p}/tasks`;
 const before=await db.task.count({where:{projectId:p}});
 for(const dueDate of [undefined,null,""])expect((await a.c.post(endpoint,{title:"ZZ-TEST reject missing",dueDate})).status).toBe(400);
 expect(await db.task.count({where:{projectId:p}})).toBe(before);
 const result=await a.c.post(endpoint,{title:"ZZ-TEST explicit leap date",dueDate:"2028-02-29"});expect(result.status).toBe(201);const dated=result.json.task.id;
 expect((await db.task.findUniqueOrThrow({where:{id:dated}})).dueDate?.toISOString()).toBe("2028-02-28T18:30:00.000Z");
 const idea=await a.c.post(endpoint,{title:"ZZ-TEST undated Idea",isIdea:true});expect(idea.status).toBe(201);expect(await db.task.findUniqueOrThrow({where:{id:idea.json.task.id},select:{isIdea:true,dueDate:true}})).toEqual({isIdea:true,dueDate:null});
 expect((await a.c.post(endpoint,{title:"ZZ-TEST subtask",parentId:dated})).status).toBe(201);
 expect((await a.c.patch(`/api/tasks/${dated}`,{dueDate:null,expectedUpdatedAt:(await db.task.findUniqueOrThrow({where:{id:dated}})).updatedAt.toISOString()})).status).toBe(200);
 expect((await db.task.findUniqueOrThrow({where:{id:dated}})).dueDate).toBeNull();
 const turn=newTurn({id:a.id,orgRole:"MEMBER"},new Date("2026-10-24T00:00:00Z"));
 await runTool(turn,"list_projects",{text:"future policy"});
 await runTool(turn,"propose_changes",{changes:[{action:"create_task",project_id:p,title:"ZZ-TEST concierge missing date"}]});expect(JSON.stringify(turn.card)).toMatch(/due date/i);
 expect(await db.task.count({where:{projectId:p,title:"ZZ-TEST concierge missing date"}})).toBe(0);
});
