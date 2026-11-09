// Mirrors src/lib/people.ts releasePerson: open holders, Leader approval duties,
// and collaboration removal only on revoke. Called inside the role transaction.
import {randomUUID} from 'node:crypto';
const refuse=()=>{throw Error('Project handover review refused');};
export async function readHandover(db,{project,target,leader,role,recipient}){
 const assignments=(await db.query(`SELECT t.id,t.title,t."assigneeId",t."approverId",t."completedAt",t."deletedAt",t.xmin::text revision,
  c.xmin::text "collaborationRevision",c."userId" IS NOT NULL collaborator
  FROM "Task" t LEFT JOIN "TaskCollaborator" c ON c."taskId"=t.id AND c."userId"=$2
  WHERE t."projectId"=$1 AND (t."assigneeId"=$2 OR t."approverId"=$2 OR c."userId" IS NOT NULL) ORDER BY t.id`,[project.id,target])).rows;
 const candidates=(await db.query(`SELECT m."userId",u.name,m.role::text role,u.xmin::text "userRevision",m.xmin::text "memberRevision",w.xmin::text "workspaceRevision"
  FROM "ProjectMember" m JOIN "User" u ON u.id=m."userId"
  LEFT JOIN "WorkspaceMembership" w ON w."userId"=u.id AND w."workspaceId"=$2
  WHERE m."projectId"=$1 AND m."userId"<>$3 AND m.role IN ('LEADER','EDITOR')
  AND u."deactivatedAt" IS NULL AND u."emailVerifiedAt" IS NOT NULL
  AND (u."workspaceId"=$2 OR (w."revokedAt" IS NULL AND w."userId" IS NOT NULL)) ORDER BY m."userId"`,[project.id,project.workspaceId,target])).rows;
 const changes=[];
 if(['VIEWER','revoke'].includes(role)){
  if(recipient && !candidates.some(x=>x.userId===recipient))refuse();
  for(const t of assignments){
   let assigneeId=t.assigneeId,approverId=t.approverId,collaborator=t.collaborator;
   const open=t.completedAt===null&&t.deletedAt===null;
   if(approverId===target){
    if(!candidates.some(x=>x.userId===leader))refuse();
    // Approval queue holder moves to Leader before general open-work handover.
    approverId=open&&assigneeId===leader?null:leader;
    if(open&&assigneeId===target)assigneeId=leader;
   }
   if(open&&assigneeId===target){if(!recipient)refuse();assigneeId=recipient;}
   if(role==='revoke')collaborator=false;
   if(assigneeId!==t.assigneeId||approverId!==t.approverId||collaborator!==t.collaborator)
    changes.push({id:t.id,assigneeId,approverId,collaborator});
  }
 }
 return {assignments,handover:{recipient,candidates,changes}};
}

export async function applyHandover(db,{project,target,actor,assignments,handover,requestId}){
 const results=[];
 for(const change of handover.changes){
  const before=assignments.find(x=>x.id===change.id);if(!before)refuse();
  // Full-row readback verifies content, status, hierarchy and history fields.
  const snapshot=(await db.query('SELECT row_to_json(t) value FROM "Task" t WHERE id=$1',[change.id])).rows[0]?.value;
  if(!snapshot)refuse();
  const otherCollaborators=(await db.query('SELECT row_to_json(c) value FROM "TaskCollaborator" c WHERE "taskId"=$1 AND "userId"<>$2 ORDER BY "userId"',[change.id,target])).rows;
  const updated=change.assigneeId!==before.assigneeId||change.approverId!==before.approverId;
  if(updated)await db.query('UPDATE "Task" SET "assigneeId"=$2,"approverId"=$3,"updatedAt"=NOW() WHERE id=$1',[change.id,change.assigneeId,change.approverId]);
  if(before.collaborator&&!change.collaborator)await db.query('DELETE FROM "TaskCollaborator" WHERE "taskId"=$1 AND "userId"=$2',[change.id,target]);
  const after=(await db.query('SELECT row_to_json(t) value FROM "Task" t WHERE id=$1',[change.id])).rows[0]?.value;
  const expected={...snapshot,assigneeId:change.assigneeId,approverId:change.approverId};
  if(updated)expected.updatedAt=after?.updatedAt;
  if(JSON.stringify(after)!==JSON.stringify(expected))refuse();
  const collaborators=(await db.query('SELECT row_to_json(c) value FROM "TaskCollaborator" c WHERE "taskId"=$1 AND "userId"<>$2 ORDER BY "userId"',[change.id,target])).rows;
  const retained=(await db.query('SELECT 1 FROM "TaskCollaborator" WHERE "taskId"=$1 AND "userId"=$2',[change.id,target])).rowCount>0;
  if(JSON.stringify(collaborators)!==JSON.stringify(otherCollaborators)||retained!==change.collaborator)refuse();
  results.push(change);
 }
 if(results.length){
  await db.query('INSERT INTO "ActionLog" (id,"actorId","projectId","targetType","targetId",action,"beforeState","afterState",channel) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',[randomUUID(),actor,project.id,'member',target,'tasks.portal_handover',{tasks:assignments.filter(x=>results.some(y=>x.id===y.id))},{tasks:results,requestId},'SCREEN']);
  // Standard SHO bell type; each new holder sees only their count.
  const recipients=new Set(results.flatMap(x=>[x.assigneeId,x.approverId]).filter(x=>x&&x!==target&&x!==actor));
  for(const recipientId of recipients){
   const moved=results.filter(x=>x.assigneeId===recipientId&&assignments.find(t=>t.id===x.id)?.assigneeId!==recipientId).length;
   const approver=results.filter(x=>x.approverId===recipientId&&assignments.find(t=>t.id===x.id)?.approverId!==recipientId).length;
   if(moved||approver)await db.query('INSERT INTO "Notification" (id,"recipientId","actorId",type,"projectId",data) VALUES ($1,$2,$3,$4,$5,$6)',[randomUUID(),recipientId,actor,'TASKS_HANDED_OVER',project.id,{fromName:'A project member',moved,approver,cleared:0,toYou:true}]);
  }
 }
 return results;
}
