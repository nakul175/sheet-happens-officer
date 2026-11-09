import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {changeWorkspaceMembership as change} from './bridge.mjs';
import {workspaceForSession as current,selectSessionWorkspace as select,listSessionWorkspaces as list} from './session.mjs';
const enabled=!!process.env.SHO_WORKSPACE_TEST_DATABASE_URL;
const opts={connectionString:process.env.SHO_WORKSPACE_TEST_DATABASE_URL,connectionTimeoutMillis:4000,
 ssl:process.env.SHO_WORKSPACE_TEST_CA?{ca:readFileSync(process.env.SHO_WORKSPACE_TEST_CA,'utf8'),servername:'db'}:undefined};
const policy={enabled:true,workspace:'extra',reviewers:['reviewer'],protectedEmails:[],reference:'Synthetic explicit additional workspace',configDigest:'b'.repeat(64)};
const input=(action='enroll',role='MEMBER')=>({actor:'reviewer',target:'target',action,role});
let db;
const preview=(action='enroll',role='MEMBER')=>change(db,policy,{...input(action,role),operation:'preview'});
const apply=async(action='enroll',role='MEMBER',expected)=>change(db,policy,{...input(action,role),operation:'apply',requestId:randomUUID(),expected:expected??await preview(action,role)});
before(async()=>{
 if(!enabled)return;
 db=new pg.Client(opts);await db.connect();
 // CI can run these service tests without application data. Isolated acceptance
 // supplies the captured schema-only baseline to exercise its actual constraints.
 if(process.env.SHO_WORKSPACE_SCHEMA_FILE){
  const text=readFileSync(process.env.SHO_WORKSPACE_SCHEMA_FILE,'utf8');let inCopy=false;
  const lines=text.split('\n').filter(line=>{if(line.startsWith('COPY ')){inCopy=true;return false;}if(inCopy){if(line==='\\.')inCopy=false;return false;}return !line.startsWith('\\');});
  await db.query(lines.join('\n'));
  await db.query('SET search_path=public');
 }else{
  await db.query(`CREATE TYPE "OrgRole" AS ENUM ('MEMBER','ADMIN','SUPER_ADMIN');
   CREATE TABLE "Workspace"(id TEXT PRIMARY KEY,name TEXT NOT NULL);
   CREATE TABLE "User"(id TEXT PRIMARY KEY,"workspaceId" TEXT REFERENCES "Workspace"(id),email TEXT,name TEXT,"passwordHash" TEXT,"orgRole" "OrgRole","emailVerifiedAt" TIMESTAMP,"deactivatedAt" TIMESTAMP);
   CREATE TABLE "Session"(id TEXT PRIMARY KEY,"userId" TEXT REFERENCES "User"(id),"tokenHash" TEXT,"expiresAt" TIMESTAMP,"revokedAt" TIMESTAMP);
   CREATE TABLE "Project"(id TEXT PRIMARY KEY,"workspaceId" TEXT,name TEXT,"updatedAt" TIMESTAMP);
   CREATE TABLE "ProjectMember"("projectId" TEXT,"userId" TEXT,role TEXT);
   CREATE TABLE "ActionLog"(id TEXT,"actorId" TEXT,channel TEXT,"projectId" TEXT,"targetType" TEXT,"targetId" TEXT,action TEXT);
   CREATE TABLE "Section"(id TEXT PRIMARY KEY,"projectId" TEXT,name TEXT,position INTEGER);
   CREATE TABLE "Task"(id TEXT PRIMARY KEY,"workspaceId" TEXT,"projectId" TEXT,"sectionId" TEXT,title TEXT,"assigneeId" TEXT,"approverId" TEXT,"createdById" TEXT,"updatedAt" TIMESTAMP);
   CREATE TABLE "TaskCollaborator"("taskId" TEXT,"userId" TEXT);
   CREATE TABLE "AuditLog"(id TEXT PRIMARY KEY,"actorId" TEXT,event TEXT,"targetId" TEXT,data JSONB,"createdAt" TIMESTAMP);`);
 }
 await db.query(readFileSync(new URL('../../prisma/migrations/20261109120000_additional_workspace_memberships/migration.sql',import.meta.url),'utf8'));
});
beforeEach(async()=>{if(!enabled)return;
 if(process.env.SHO_WORKSPACE_SCHEMA_FILE) await db.query("INSERT INTO \"WorkstreamType\" VALUES ('wst_project','project','Project') ON CONFLICT DO NOTHING");
 await db.query(`TRUNCATE "TaskCollaborator","Task","Section","Workspace","User","Session","Project","ProjectMember","ActionLog","AuditLog","WorkspaceMembership","SessionWorkspace","PortalWorkspaceReceipt" CASCADE;
  INSERT INTO "Workspace"(id,name) VALUES ('home','Original'),('extra','Additional'),('foreign','Unassigned');
  INSERT INTO "User"(id,"workspaceId",email,name,"passwordHash","orgRole","emailVerifiedAt") VALUES
   ('reviewer','extra','reviewer@example.invalid','Reviewer','!synthetic!','SUPER_ADMIN',NOW()),
   ('target','home','target@example.invalid','Target','!synthetic!','ADMIN',NOW()),
   ('unrelated','foreign','other@example.invalid','Other','!synthetic!','MEMBER',NOW());
  INSERT INTO "Session"(id,"userId","tokenHash","expiresAt") VALUES ('s','target','synthetic-hash',NOW()+INTERVAL '1 day'),('s2','target','synthetic-hash2',NOW()+INTERVAL '1 day'),('other','unrelated','synthetic-other',NOW()+INTERVAL '1 day');`);
});
after(async()=>{await db?.end()});
const opt={skip:!enabled};
test('flag-off, unknown roles, self, missing review and initial Admin are refused before I/O',async()=>{
 const fake={query(){throw Error('Unexpected database read')}};
 for(const [p,i] of [[{...policy,enabled:false},input()],[policy,input('enroll','ADMIN')],[policy,input('role','SUPER_ADMIN')],[{...policy,reference:''},input()],[policy,{...input(),target:'reviewer'}]]){
  await assert.rejects(change(fake,p,{...i,operation:'preview'}),/Additional workspace review refused/);
 }
});
test('new membership preserves original account, role, sessions and workspaces; same session roles refresh',opt,async()=>{
 const users=(await db.query('SELECT * FROM "User" ORDER BY id')).rows;
 const sessions=(await db.query('SELECT * FROM "Session" ORDER BY id')).rows;
 assert.equal((await current(db,'s',true)).role,'ADMIN');
 assert.equal((await list(db,'s',true)).length,1);
 const plan=await preview();assert.equal(plan.membership,null);
 assert.equal((await db.query('SELECT count(*) FROM "WorkspaceMembership"')).rows[0].count,'0');
 await apply('enroll','MEMBER',plan);
 assert.equal((await list(db,'s',true)).length,2);
 await select(db,'s','extra',true);
 assert.equal((await current(db,'s',true)).role,'MEMBER');
 assert.equal((await current(db,'s2',true)).workspaceId,'home');
 await apply('role','ADMIN');assert.equal((await current(db,'s',true)).role,'ADMIN');
 await apply('role','MEMBER');assert.equal((await current(db,'s',true)).role,'MEMBER');
 await apply('revoke',null);await assert.rejects(current(db,'s',true));
 assert.equal((await current(db,'s2',true)).role,'ADMIN');
 await apply('regrant','MEMBER');await assert.rejects(current(db,'s',true));
 await select(db,'s','extra',true);assert.equal((await current(db,'s',true)).role,'MEMBER');
 await select(db,'s','home',true);assert.equal((await current(db,'s',true)).role,'ADMIN');
 assert.deepEqual((await db.query('SELECT * FROM "User" ORDER BY id')).rows,users);
 assert.deepEqual((await db.query('SELECT * FROM "Session" ORDER BY id')).rows,sessions);
});
test('expired, revoked, globally disabled and foreign sessions cannot switch/read',opt,async()=>{
 await apply();await select(db,'s','extra',true);
 await assert.rejects(select(db,'s','foreign',true));
 await assert.rejects(select(db,'other','extra',true));
 for(const flag of [false,undefined,'false','true',1]){
  await assert.rejects(current(db,'s',flag));await assert.rejects(select(db,'s','extra',flag));
  assert.equal((await list(db,'s',flag)).length,1);
 }
 for(const stmt of ['UPDATE "Session" SET "revokedAt"=NOW() WHERE id=\'s\'','UPDATE "Session" SET "expiresAt"=NOW()-INTERVAL \'1 minute\' WHERE id=\'s\'','UPDATE "User" SET "deactivatedAt"=NOW() WHERE id=\'target\'']){
  await db.query(stmt);await assert.rejects(current(db,'s',true));await assert.rejects(select(db,'s','home',true));
  await db.query('UPDATE "Session" SET "revokedAt"=NULL,"expiresAt"=NOW()+INTERVAL \'1 day\' WHERE id=\'s\'; UPDATE "User" SET "deactivatedAt"=NULL');
 }
});
test('native constraints reject duplicate home authority, extra Super Admin and foreign session ownership',opt,async()=>{
 await assert.rejects(db.query('INSERT INTO "WorkspaceMembership"("userId","workspaceId") VALUES (\'target\',\'home\')'),e=>e.code==='23514');
 await assert.rejects(db.query('INSERT INTO "WorkspaceMembership"("userId","workspaceId",role) VALUES (\'target\',\'extra\',\'SUPER_ADMIN\')'),e=>e.code==='23514');
 await apply();
 await assert.rejects(db.query('INSERT INTO "SessionWorkspace"("sessionId","userId","workspaceId",generation) VALUES (\'other\',\'target\',\'extra\',1)'),e=>e.code==='23503');
});
test('stale review, duplicate confirm, changed reviewer and protected original authority deny',opt,async()=>{
 const p=await preview();await db.query('UPDATE "User" SET name=\'Changed\' WHERE id=\'target\'');await assert.rejects(apply('enroll','MEMBER',p));
 await apply();await assert.rejects(apply());
 await db.query('UPDATE "User" SET "orgRole"=\'ADMIN\' WHERE id=\'reviewer\'');await assert.rejects(preview('role','ADMIN'));
 await db.query('UPDATE "User" SET "orgRole"=\'SUPER_ADMIN\' WHERE id IN (\'reviewer\',\'target\')');await assert.rejects(preview('role','ADMIN'));
});
test('pre-existing project roles or creator authority block silent enrollment',opt,async()=>{
 await db.query('INSERT INTO "Project"(id,"workspaceId",name,"updatedAt") VALUES (\'p\',\'extra\',\'Preserved\',NOW())');
 await db.query('INSERT INTO "ProjectMember"("projectId","userId",role) VALUES (\'p\',\'target\',\'VIEWER\')');await assert.rejects(preview());
 await db.query('DELETE FROM "ProjectMember"');
 await db.query('INSERT INTO "ActionLog"(id,"actorId",channel,"projectId","targetType","targetId",action) VALUES (\'a\',\'target\',\'SCREEN\',\'p\',\'project\',\'p\',\'project.created\')');await assert.rejects(preview());
});
test('receipt and audit failure roll back all authority effects',opt,async()=>{
 await db.query('ALTER TABLE "AuditLog" ADD CONSTRAINT fixture_failure CHECK(false)');await assert.rejects(apply());
 assert.equal((await db.query('SELECT count(*) FROM "WorkspaceMembership"')).rows[0].count,'0');
 assert.equal((await db.query('SELECT count(*) FROM "PortalWorkspaceReceipt"')).rows[0].count,'0');
 await db.query('ALTER TABLE "AuditLog" DROP CONSTRAINT fixture_failure');
 let calls=0;const p=await preview();await assert.rejects(change(db,policy,{...input(),operation:'apply',requestId:randomUUID(),expected:p},()=>++calls===1));
 assert.equal((await db.query('SELECT count(*) FROM "WorkspaceMembership"')).rows[0].count,'0');
});
test('concurrent exact enrollment confirms have one winner and one receipt',opt,async()=>{
 const other=new pg.Client(opts);await other.connect();try{
  const p=await preview();const attempts=await Promise.allSettled([db,other].map(c=>change(c,policy,{...input(),operation:'apply',requestId:randomUUID(),expected:p})));
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  assert.equal((await db.query('SELECT count(*) FROM "WorkspaceMembership"')).rows[0].count,'1');
  assert.equal((await db.query('SELECT count(*) FROM "PortalWorkspaceReceipt"')).rows[0].count,'1');
 }finally{await other.end()}
});

test('existing direct task authority blocks initial enrollment and preserves the task',opt,async()=>{
 await db.query(`INSERT INTO "Project"(id,"workspaceId",name,"updatedAt") VALUES ('p','extra','Preserved',NOW());
  INSERT INTO "Section"(id,"projectId",name,position) VALUES ('sec','p','Work',1);
  INSERT INTO "ProjectMember"("projectId","userId",role) VALUES ('p','reviewer','LEADER');
  INSERT INTO "Task"(id,"workspaceId","projectId","sectionId",title,"assigneeId","createdById","updatedAt")
   VALUES ('task','extra','p','sec','Preserve this work','reviewer','reviewer',NOW());
  INSERT INTO "TaskCollaborator"("taskId","userId") VALUES ('task','target');`);
 const task=(await db.query('SELECT * FROM "Task"')).rows;
 await assert.rejects(preview());
 assert.deepEqual((await db.query('SELECT * FROM "Task"')).rows,task);
});

test('additive migration and rollback preserve every populated original native table',opt,async()=>{
 await db.query(`INSERT INTO "Project"(id,"workspaceId",name,"updatedAt") VALUES ('p','home','Original work',NOW());
  INSERT INTO "Section"(id,"projectId",name,position) VALUES ('sec','p','Original section',1);
  INSERT INTO "ProjectMember"("projectId","userId",role) VALUES ('p','target','LEADER');
  INSERT INTO "Task"(id,"workspaceId","projectId","sectionId",title,"assigneeId","createdById","updatedAt")
   VALUES ('task','home','p','sec','Original business content','target','target',NOW());`);
 const added=new Set(['WorkspaceMembership','SessionWorkspace','PortalWorkspaceReceipt']);
 const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(r=>r.tablename).filter(n=>!added.has(n));
 const snapshot=async()=>{
  const result={};
  for(const n of tables) result[n]=(await db.query(`SELECT row_to_json(t)::text value FROM "${n.replaceAll('"','""')}" t ORDER BY row_to_json(t)::text`)).rows.map(r=>r.value);
  return result;
 };
 const before=await snapshot();
 const rollback=`DROP TABLE "SessionWorkspace"; DROP TABLE "WorkspaceMembership"; DROP TABLE "PortalWorkspaceReceipt";
  DROP INDEX "Session_id_userId_key"; DROP FUNCTION sho_additional_workspace_only();`;
 await db.query(rollback);
 assert.deepEqual(await snapshot(),before);
 await db.query(readFileSync(new URL('../../prisma/migrations/20261109120000_additional_workspace_memberships/migration.sql',import.meta.url),'utf8'));
 assert.deepEqual(await snapshot(),before);
 assert.equal((await current(db,'s',true)).role,'ADMIN');
});
