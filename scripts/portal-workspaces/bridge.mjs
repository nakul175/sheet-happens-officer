// Private OS-local Portal adapter. Disabled unless explicitly configured.
// Changes additional workspace membership only, never User or project roles.
import {createHash,randomUUID} from 'node:crypto';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const id=x=>typeof x==='string' && /^[A-Za-z0-9_-]{1,200}$/.test(x);
const uuid=x=>typeof x==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const refuse=()=>{throw Error('Additional workspace review refused');};
export async function changeWorkspaceMembership(db,policy,input,configUnchanged=()=>true) {
  if (policy.enabled!==true || !id(policy.workspace) || !policy.reference?.trim()
      || !/^[a-f0-9]{64}$/.test(policy.configDigest) || !Array.isArray(policy.reviewers)
      || !Array.isArray(policy.protectedEmails) || !id(input.actor) || !id(input.target)
      || input.actor===input.target || !policy.reviewers.includes(input.actor)
      || !['preview','apply'].includes(input.operation)
      || !['enroll','role','revoke','regrant'].includes(input.action)) refuse();
  if (input.action==='enroll' && input.role!=='MEMBER') refuse();
  if (input.action==='role' && !['MEMBER','ADMIN'].includes(input.role)) refuse();
  if (input.action==='regrant' && input.role!=='MEMBER') refuse();
  if (input.action==='revoke' && input.role!==null) refuse();
  if (input.operation==='apply' && (!uuid(input.requestId) || !input.expected)) refuse();
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await db.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='8s'");
    // All membership mutations use this exact target/workspace serialization key.
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([policy.workspace,input.target])]);
    const users=(await db.query(`SELECT id,"workspaceId","orgRole"::text role,email,
      "emailVerifiedAt","deactivatedAt",xmin::text revision FROM "User"
      WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE`,[[input.actor,input.target]])).rows;
    const a=users.find(u=>u.id===input.actor),t=users.find(u=>u.id===input.target);
    if (!a || !t || a.workspaceId!==policy.workspace || a.role!=='SUPER_ADMIN'
        || t.workspaceId===policy.workspace || t.role==='SUPER_ADMIN'
        || a.deactivatedAt || t.deactivatedAt || !a.emailVerifiedAt || !t.emailVerifiedAt
        || policy.protectedEmails.includes(t.email.toLowerCase())) refuse();
    const m=(await db.query(`SELECT role::text role,generation,"revokedAt",xmin::text revision
      FROM "WorkspaceMembership" WHERE "userId"=$1 AND "workspaceId"=$2 FOR UPDATE`,[t.id,policy.workspace])).rows[0]??null;
    if ((input.action==='enroll' && m) || (input.action==='role' && (!m || m.revokedAt))
      || (input.action==='revoke' && (!m || m.revokedAt)) || (input.action==='regrant' && (!m || !m.revokedAt))) refuse();
    // New entry must not silently reactivate pre-existing project roles/creator authority.
    // Regrant exposes the exact preserved assignments in the review instead.
    const projects=(await db.query(`SELECT p.id,m.role::text role,
      EXISTS(SELECT 1 FROM "ActionLog" l WHERE l."projectId"=p.id AND l."actorId"=$1
        AND l.action IN ('project.created','deal.created')) creator
      FROM "Project" p LEFT JOIN "ProjectMember" m ON m."projectId"=p.id AND m."userId"=$1
      WHERE p."workspaceId"=$2 AND (m."userId" IS NOT NULL OR EXISTS
        (SELECT 1 FROM "ActionLog" l WHERE l."projectId"=p.id AND l."actorId"=$1
          AND l.action IN ('project.created','deal.created'))) ORDER BY p.id`,[t.id,policy.workspace])).rows;
    const tasks=(await db.query(`SELECT t.id,t."projectId",t."assigneeId",t."approverId",t."createdById",
      EXISTS(SELECT 1 FROM "TaskCollaborator" c WHERE c."taskId"=t.id AND c."userId"=$1) collaborator
      FROM "Task" t WHERE t."workspaceId"=$2 AND (t."assigneeId"=$1 OR t."approverId"=$1
        OR t."createdById"=$1 OR EXISTS(SELECT 1 FROM "TaskCollaborator" c WHERE c."taskId"=t.id AND c."userId"=$1))
      ORDER BY t.id`,[t.id,policy.workspace])).rows;
    if (input.action==='enroll' && (projects.length || tasks.length)) refuse();
    const before={workspace:policy.workspace,actor:a.id,actorRevision:a.revision,target:t.id,
      targetRevision:t.revision,originalWorkspace:t.workspaceId,originalRole:t.role,
      membership:m,projects,tasks,action:input.action,role:input.role,reference:policy.reference,configDigest:policy.configDigest};
    if (!configUnchanged()) refuse();
    if (input.operation==='preview') {await db.query('COMMIT');return before;}
    if (digest(input.expected)!==digest(before)) refuse();
    await db.query('INSERT INTO "PortalWorkspaceReceipt" (id,"actorId","targetId","workspaceId",result) VALUES ($1,$2,$3,$4,$5)',[input.requestId,a.id,t.id,policy.workspace,{}]);
    if (input.action==='enroll') {
      await db.query('INSERT INTO "WorkspaceMembership" ("userId","workspaceId",role) VALUES ($1,$2,\'MEMBER\')',[t.id,policy.workspace]);
    } else if (input.action==='role') {
      await db.query('UPDATE "WorkspaceMembership" SET role=$3::"OrgRole","updatedAt"=NOW() WHERE "userId"=$1 AND "workspaceId"=$2',[t.id,policy.workspace,input.role]);
    } else {
      await db.query(`UPDATE "WorkspaceMembership" SET generation=generation+1,"updatedAt"=NOW(),
        "revokedAt"=${input.action==='revoke'?'NOW()':'NULL'},role='MEMBER'
        WHERE "userId"=$1 AND "workspaceId"=$2`,[t.id,policy.workspace]);
    }
    const after=(await db.query('SELECT role::text role,generation,"revokedAt",xmin::text revision FROM "WorkspaceMembership" WHERE "userId"=$1 AND "workspaceId"=$2',[t.id,policy.workspace])).rows[0];
    if (!after || !configUnchanged()) refuse();
    await db.query('INSERT INTO "AuditLog" (id,"actorId",event,"targetId",data,"createdAt") VALUES ($1,$2,$3,$4,$5,NOW())',
      [randomUUID(),a.id,'PORTAL_WORKSPACE_'+input.action.toUpperCase(),t.id,{workspaceId:policy.workspace,role:after.role,requestId:input.requestId}]);
    const result={requestId:input.requestId,before,after};
    await db.query('UPDATE "PortalWorkspaceReceipt" SET result=$1 WHERE id=$2',[result,input.requestId]);
    await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
}
