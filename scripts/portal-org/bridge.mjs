// OS-local connector. No HTTP endpoint, native password or identity creation.
import {createHash, randomUUID} from 'node:crypto';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const id = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(x);
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(x);
const refuse = () => { throw Error('Native organisation authority refused'); };

export async function changeOrgRole(db, policy, input, configUnchanged = () => true) {
  if (!policy.enabled || !id(policy.workspace) || !Array.isArray(policy.reviewers)
      || !Array.isArray(policy.protectedEmails) || !policy.reference?.trim()
      || !/^[a-f0-9]{64}$/.test(policy.configDigest) || !id(input.actor) || !id(input.target)
      || input.actor === input.target || !policy.reviewers.includes(input.actor)
      || !['preview','apply'].includes(input.operation)) refuse();
  if (input.operation === 'apply' && (!uuid(input.requestId)
      || !['MEMBER','ADMIN'].includes(input.role) || !input.expected)) refuse();
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await db.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='8s'");
    // Deterministic row locks serialize native and Portal role edits. Membership
    // rows are not mutated: project roles remain an independent source of access.
    const rows = (await db.query('SELECT id,"workspaceId","orgRole"::text role,email,"emailVerifiedAt","deactivatedAt",xmin::text revision FROM "User" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [[input.actor,input.target]])).rows;
    const actor=rows.find(r=>r.id===input.actor),target=rows.find(r=>r.id===input.target);
    if (rows.length!==2 || actor.workspaceId!==policy.workspace || target.workspaceId!==policy.workspace
        || actor.role!=='SUPER_ADMIN' || !['MEMBER','ADMIN'].includes(target.role)
        || actor.deactivatedAt || target.deactivatedAt || !actor.emailVerifiedAt || !target.emailVerifiedAt
        || policy.protectedEmails.includes(target.email.toLowerCase())) refuse();
    const before = {workspace:policy.workspace,actor:actor.id,actorRevision:actor.revision,
      target:target.id,targetRevision:target.revision,role:target.role,configDigest:policy.configDigest,
      reference:policy.reference};
    if (!configUnchanged()) refuse();
    if (input.operation==='preview') {await db.query('COMMIT');return before;}
    const fields=Object.keys(before);
    if (Object.keys(input.expected).length!==fields.length || fields.some(k=>input.expected[k]!==before[k])) refuse();
    // Single-use request key is inserted before effects; a collision rolls back.
    await db.query('INSERT INTO "PortalOrgRoleReceipt" (id,"actorId","targetId","workspaceId",result) VALUES ($1,$2,$3,$4,$5)',
      [input.requestId,actor.id,target.id,policy.workspace,{}]);
    const changed=target.role!==input.role;
    if (changed) {
      const written=await db.query('UPDATE "User" SET "orgRole"=$1::"OrgRole" WHERE id=$2', [input.role,target.id]);
      if (written.rowCount!==1) refuse();
      await db.query('INSERT INTO "AuditLog" (id,"actorId",event,"targetId",data,"createdAt") VALUES ($1,$2,$3,$4,$5,NOW())',
        [randomUUID(),actor.id,input.role==='ADMIN'?'ADMIN_PROMOTED':'ADMIN_DEMOTED',target.id,{role:input.role,portalRequestId:input.requestId}]);
      await db.query('INSERT INTO "Notification" (id,"recipientId","actorId",type,data,"createdAt") VALUES ($1,$2,$3,$4,$5,NOW())',
        [randomUUID(),target.id,actor.id,'ORG_ROLE_CHANGED',{role:input.role,portalRequestId:input.requestId}]);
    }
    const readback=(await db.query('SELECT "orgRole"::text role,xmin::text revision FROM "User" WHERE id=$1',[target.id])).rows[0];
    if (readback?.role!==input.role || !configUnchanged()) refuse();
    const result={requestId:input.requestId,changed,before,after:{...before,role:readback.role,targetRevision:readback.revision}};
    await db.query('UPDATE "PortalOrgRoleReceipt" SET result=$1 WHERE id=$2',[result,input.requestId]);
    await db.query('COMMIT');return result;
  } catch(error) { await db.query('ROLLBACK').catch(()=>{}); throw error; }
}
