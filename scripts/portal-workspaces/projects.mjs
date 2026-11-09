// Exact additional-workspace project roles with explicitly reviewed native task handover.
import {createHash,randomUUID} from 'node:crypto';
import {readHandover,applyHandover} from './handover.mjs';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const id=x=>typeof x==='string' && /^[A-Za-z0-9_-]{1,200}$/.test(x);
const refuse=()=>{throw Error('Project authority review refused');};
export async function changeWorkspaceProject(db,policy,input,unchanged=()=>true){
 if(policy.enabled!==true || policy.projectsEnabled!==true || !id(policy.workspace) || !id(input.project)
   || !policy.reference?.trim() || !/^[a-f0-9]{64}$/.test(policy.configDigest)
   || !Array.isArray(policy.reviewers) || !Array.isArray(policy.protectedEmails)
   || !id(input.actor) || !id(input.target) || input.actor===input.target || !policy.reviewers.includes(input.actor)
   || !['preview','apply'].includes(input.operation) || !['LEADER','EDITOR','VIEWER','revoke','inspect','list'].includes(input.role) || (['inspect','list'].includes(input.role)&&input.operation!=='preview')
   || (input.handoverTo!=null && (!id(input.handoverTo) || !['VIEWER','revoke'].includes(input.role)))
   || !Array.isArray(policy.projects) || !policy.projects.every(id) || (input.role!=='list'&&!policy.projects.includes(input.project))
   || (input.operation==='apply' && (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.requestId??'') || !input.expected)))refuse();
 await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
 try{
  await db.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='8s'");
  // Shared with ordinary native writers: prevent a handover/creator/leader race.
  await db.query('LOCK TABLE "ProjectMember" IN SHARE ROW EXCLUSIVE MODE');
  await db.query('LOCK TABLE "ActionLog","Task","TaskCollaborator","User","WorkspaceMembership" IN SHARE MODE');
  // Take the SERIALIZABLE snapshot only after table locks are acquired.
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([policy.workspace,input.target])]);
  const users=(await db.query(`SELECT id,"workspaceId","orgRole"::text role,email,"emailVerifiedAt","deactivatedAt",xmin::text revision FROM "User" WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`,[[input.actor,input.target]])).rows;
  const a=users.find(x=>x.id===input.actor),t=users.find(x=>x.id===input.target);
  if(!a||!t||a.workspaceId!==policy.workspace||a.role!=='SUPER_ADMIN'||t.workspaceId===policy.workspace
    ||t.role==='SUPER_ADMIN'||a.deactivatedAt||t.deactivatedAt||!a.emailVerifiedAt||!t.emailVerifiedAt
    ||policy.protectedEmails.includes(t.email.toLowerCase()))refuse();
  const membership=(await db.query(`SELECT role::text role,generation,"revokedAt",xmin::text revision FROM "WorkspaceMembership" WHERE "userId"=$1 AND "workspaceId"=$2 FOR SHARE`,[t.id,policy.workspace])).rows[0];
  // Admin authority overrides all project roles. Change workspace role first.
  if(!membership||membership.revokedAt||membership.role!=='MEMBER')refuse();
  if(input.role==='list'){
   const projects=(await db.query(`SELECT id,name FROM "Project" WHERE "workspaceId"=$1 AND id=ANY($2::text[]) AND "archivedAt" IS NULL AND "deletedAt" IS NULL ORDER BY name,id`,[policy.workspace,policy.projects])).rows;
   if(!unchanged())refuse();await db.query('COMMIT');return {workspace:policy.workspace,target:t.id,projects,configDigest:policy.configDigest};
  }
  const project=(await db.query(`SELECT id,name,"workspaceId","archivedAt","deletedAt",xmin::text revision FROM "Project" WHERE id=$1 FOR UPDATE`,[input.project])).rows[0];
  if(!project||project.workspaceId!==policy.workspace||project.archivedAt||project.deletedAt)refuse();
  const members=(await db.query(`SELECT m."userId",m.role::text role,m.xmin::text revision,u.name FROM "ProjectMember" m JOIN "User" u ON u.id=m."userId" WHERE m."projectId"=$1 ORDER BY m."userId"`,[project.id])).rows;
  const mine=members.find(x=>x.userId===t.id),leaders=members.filter(x=>x.role==='LEADER');
  if(leaders.length!==1 || (mine?.role==='LEADER'&&['EDITOR','VIEWER','revoke'].includes(input.role)) || (['revoke','LEADER'].includes(input.role)&&!mine))refuse();
  const creator=(await db.query(`SELECT id,xmin::text revision FROM "ActionLog" WHERE "projectId"=$1 AND "actorId"=$2 AND action IN ('project.created','deal.created') ORDER BY id`,[project.id,t.id])).rows;
  if(creator.length && ['EDITOR','VIEWER'].includes(input.role))refuse();
  const {assignments,handover}=await readHandover(db,{project,target:t.id,leader:leaders[0].userId,role:input.role,recipient:input.handoverTo??null});
  const before={workspace:policy.workspace,actor:a.id,actorRevision:a.revision,target:t.id,targetRevision:t.revision,
   originalWorkspace:t.workspaceId,originalRole:t.role,membership,project,members,creator,assignments,handover,
   role:input.role,reference:policy.reference,configDigest:policy.configDigest};
  if(!unchanged())refuse();
  if(input.operation==='preview'){await db.query('COMMIT');return before;}
  if(digest(before)!==digest(input.expected))refuse();
  await db.query('INSERT INTO "PortalWorkspaceReceipt" (id,"actorId","targetId","workspaceId",result) VALUES ($1,$2,$3,$4,$5)',[input.requestId,a.id,t.id,policy.workspace,{}]);
  const handedOver=await applyHandover(db,{project,target:t.id,actor:a.id,assignments,handover,requestId:input.requestId});
  if(input.role==='LEADER' && leaders[0].userId!==t.id){
   // Native Change Leader semantics: previous Leader remains an Editor. Review pins both seats.
   await db.query(`UPDATE "ProjectMember" SET role='EDITOR' WHERE "projectId"=$1 AND "userId"=$2`,[project.id,leaders[0].userId]);
  }
  if(input.role==='revoke')await db.query('DELETE FROM "ProjectMember" WHERE "projectId"=$1 AND "userId"=$2',[project.id,t.id]);
  else if(mine)await db.query('UPDATE "ProjectMember" SET role=$3::"ProjectRole" WHERE "projectId"=$1 AND "userId"=$2',[project.id,t.id,input.role]);
  else await db.query('INSERT INTO "ProjectMember" ("projectId","userId",role) VALUES ($1,$2,$3::"ProjectRole")',[project.id,t.id,input.role]);
  const after=(await db.query(`SELECT "userId",role::text role FROM "ProjectMember" WHERE "projectId"=$1 ORDER BY "userId"`,[project.id])).rows;
  const expected=members.filter(x=>x.userId!==t.id).map(x=>({userId:x.userId,role:input.role==='LEADER'&&x.role==='LEADER'?'EDITOR':x.role}));
  if(input.role!=='revoke')expected.push({userId:t.id,role:input.role});expected.sort((a,b)=>a.userId.localeCompare(b.userId));
  if(after.length!==expected.length || !after.every(x=>expected.some(y=>x.userId===y.userId&&x.role===y.role)) || after.filter(x=>x.role==='LEADER').length!==1 || !unchanged())refuse();
  await db.query('INSERT INTO "AuditLog" (id,"actorId",event,"targetId",data,"createdAt") VALUES ($1,$2,$3,$4,$5,NOW())',[randomUUID(),a.id,'PORTAL_WORKSPACE_PROJECT_ROLE',t.id,{projectId:project.id,workspaceId:policy.workspace,role:input.role,requestId:input.requestId}]);
  await db.query('INSERT INTO "ActionLog" (id,"actorId","projectId","targetType","targetId",action,"beforeState","afterState",channel) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),a.id,project.id,'member',t.id,'member.portal_role_changed',{role:mine?.role??null},{role:input.role,requestId:input.requestId,handover:handedOver},'SCREEN']);
  const result={requestId:input.requestId,before,after,handover:handedOver};await db.query('UPDATE "PortalWorkspaceReceipt" SET result=$1 WHERE id=$2',[result,input.requestId]);
  await db.query('COMMIT');return result;
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}
}
