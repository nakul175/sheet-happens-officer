// Native session workspace authority. Call only after central-session validation.
// Parameterized SQL is shared by runtime adapters and real PostgreSQL qualification.
const deny = () => { throw Error('Workspace authority unavailable'); };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
async function session(db, sessionId) {
  if (!validId(sessionId)) deny();
  const row = (await db.query(`SELECT s.id,s."userId",u."workspaceId",u."orgRole"::text role
    FROM "Session" s JOIN "User" u ON u.id=s."userId"
    WHERE s.id=$1 AND s."revokedAt" IS NULL AND s."expiresAt">NOW()
      AND u."deactivatedAt" IS NULL AND u."emailVerifiedAt" IS NOT NULL`, [sessionId])).rows[0];
  if (!row) deny();
  return row;
}
export async function workspaceForSession(db, sessionId, enabled) {
  const s = await session(db, sessionId);
  const selected = (await db.query(`SELECT c."workspaceId",c.generation,
    m.role::text role,m.generation current_generation,m."revokedAt"
    FROM "SessionWorkspace" c JOIN "WorkspaceMembership" m
    ON m."userId"=c."userId" AND m."workspaceId"=c."workspaceId"
    WHERE c."sessionId"=$1 AND c."userId"=$2`, [s.id,s.userId])).rows[0];
  if (!selected) return {userId:s.userId,workspaceId:s.workspaceId,role:s.role,generation:null,original:true};
  if (enabled!==true || selected.revokedAt || selected.generation!==selected.current_generation
      || !['MEMBER','ADMIN'].includes(selected.role)) deny();
  return {userId:s.userId,workspaceId:selected.workspaceId,role:selected.role,generation:selected.generation,original:false};
}
export async function listSessionWorkspaces(db, sessionId, enabled) {
  const s = await session(db,sessionId);
  const original = (await db.query('SELECT id,name FROM "Workspace" WHERE id=$1',[s.workspaceId])).rows[0];
  if (!original) deny();
  const rows=enabled===true ? (await db.query(`SELECT w.id,w.name,m.role::text role,m.generation
    FROM "WorkspaceMembership" m JOIN "Workspace" w ON w.id=m."workspaceId"
    WHERE m."userId"=$1 AND m."revokedAt" IS NULL ORDER BY w.name,w.id`,[s.userId])).rows : [];
  return [{...original,role:s.role,generation:null,original:true},...rows.map(r=>({...r,original:false}))];
}
export async function selectSessionWorkspace(db, sessionId, workspaceId, enabled) {
  if (enabled!==true || !validId(workspaceId)) deny();
  await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await db.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='8s'");
    const s=await session(db,sessionId);
    // Native logout and workspace switch serialize on the same Session row.
    await db.query('SELECT id FROM "Session" WHERE id=$1 FOR UPDATE',[s.id]);
    await session(db,sessionId);
    if (workspaceId===s.workspaceId) {
      await db.query('DELETE FROM "SessionWorkspace" WHERE "sessionId"=$1',[s.id]);
    } else {
      const m=(await db.query(`SELECT role::text role,generation FROM "WorkspaceMembership"
        WHERE "userId"=$1 AND "workspaceId"=$2 AND "revokedAt" IS NULL FOR SHARE`,[s.userId,workspaceId])).rows[0];
      if (!m || !['MEMBER','ADMIN'].includes(m.role)) deny();
      await db.query(`INSERT INTO "SessionWorkspace" ("sessionId","userId","workspaceId",generation)
        VALUES ($1,$2,$3,$4) ON CONFLICT ("sessionId") DO UPDATE SET
        "workspaceId"=EXCLUDED."workspaceId",generation=EXCLUDED.generation,"selectedAt"=NOW()`,
        [s.id,s.userId,workspaceId,m.generation]);
    }
    const result=await workspaceForSession(db,sessionId,enabled);
    await db.query('COMMIT');return result;
  } catch(error) {await db.query('ROLLBACK').catch(()=>{});throw error;}
}
