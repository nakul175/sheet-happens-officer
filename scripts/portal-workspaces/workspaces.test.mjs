import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {changeWorkspaceProject as projectChange} from './projects.mjs';
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
   CREATE TYPE "ProjectRole" AS ENUM ('LEADER','EDITOR','VIEWER');
   CREATE TABLE "Project"(id TEXT PRIMARY KEY,"workspaceId" TEXT,name TEXT,"updatedAt" TIMESTAMP,"archivedAt" TIMESTAMP,"deletedAt" TIMESTAMP);
   CREATE TABLE "ProjectMember"("projectId" TEXT,"userId" TEXT,role "ProjectRole", PRIMARY KEY("projectId","userId"));
   CREATE TABLE "ActionLog"(id TEXT,"actorId" TEXT,channel TEXT,"projectId" TEXT,"targetType" TEXT,"targetId" TEXT,action TEXT,"beforeState" JSONB,"afterState" JSONB);
   CREATE TABLE "Section"(id TEXT PRIMARY KEY,"projectId" TEXT,name TEXT,position INTEGER);
   CREATE TABLE "Task"(id TEXT PRIMARY KEY,"workspaceId" TEXT,"projectId" TEXT,"sectionId" TEXT,title TEXT,"assigneeId" TEXT,"approverId" TEXT,"createdById" TEXT,"updatedAt" TIMESTAMP,"completedAt" TIMESTAMP,"deletedAt" TIMESTAMP);
   CREATE TABLE "TaskCollaborator"("taskId" TEXT,"userId" TEXT);
   CREATE TABLE "Notification"(id TEXT PRIMARY KEY,"recipientId" TEXT,"actorId" TEXT,type TEXT,"projectId" TEXT,data JSONB);
   CREATE TABLE "AuditLog"(id TEXT PRIMARY KEY,"actorId" TEXT,event TEXT,"targetId" TEXT,data JSONB,"createdAt" TIMESTAMP);`);
 }
 await db.query(readFileSync(new URL('../../prisma/migrations/20261109120000_additional_workspace_memberships/migration.sql',import.meta.url),'utf8'));
});
beforeEach(async()=>{if(!enabled)return;
 if(process.env.SHO_WORKSPACE_SCHEMA_FILE) await db.query("INSERT INTO \"WorkstreamType\" VALUES ('wst_project','project','Project') ON CONFLICT DO NOTHING");
 await db.query(`TRUNCATE "Notification","TaskCollaborator","Task","Section","Workspace","User","Session","Project","ProjectMember","ActionLog","AuditLog","WorkspaceMembership","SessionWorkspace","PortalWorkspaceReceipt" CASCADE;
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

// Additional-workspace project editor: exercised on the same transactional store.
const projectPolicy={...policy,projectsEnabled:true,projects:['p']};
async function projectFixture(){
 await apply();
 await db.query(`INSERT INTO "Project"(id,"workspaceId",name,"updatedAt") VALUES ('p','extra','Reviewed project',NOW());
 INSERT INTO "ProjectMember"("projectId","userId",role) VALUES ('p','reviewer','LEADER');`);
}
async function projectPreview(role='EDITOR',extra={}){return projectChange(db,projectPolicy,{...input(),project:'p',role,operation:'preview',...extra});}
async function projectApply(role='EDITOR',expected,handoverTo=null){return projectChange(db,projectPolicy,{...input(),project:'p',role,operation:'apply',requestId:randomUUID(),handoverTo,expected:expected??await projectPreview(role,{handoverTo})});}
test('project flag, unknown scope/role and inspect writes deny before I/O',async()=>{
 const fake={query(){throw Error('Unexpected I/O')}};
 for(const [p,i] of [[{...projectPolicy,projectsEnabled:false},{}],[projectPolicy,{role:'SUPER_ADMIN'}],[projectPolicy,{project:'../bad'}],[projectPolicy,{role:'inspect',operation:'apply'}]])
  await assert.rejects(projectChange(fake,p,{...input(),project:'p',operation:'preview',role:'EDITOR',...i}),/Project authority review refused/);
});
test('project grant downgrade revoke and regrant preserve home authority and selected sessions',opt,async()=>{
 await projectFixture();await select(db,'s','extra',true);
 const before={users:(await db.query('SELECT * FROM "User" ORDER BY id')).rows,sessions:(await db.query('SELECT * FROM "Session" ORDER BY id')).rows,membership:(await db.query('SELECT * FROM "WorkspaceMembership"')).rows,selection:(await db.query('SELECT * FROM "SessionWorkspace"')).rows};
 for(const role of ['VIEWER','EDITOR','VIEWER','revoke','VIEWER']){
  const result=await projectApply(role);assert.equal(result.after.find(x=>x.userId==='target')?.role,role==='revoke'?undefined:role);
  assert.equal((await current(db,'s',true)).workspaceId,'extra');assert.equal((await current(db,'s2',true)).workspaceId,'home');
 }
 assert.deepEqual({users:(await db.query('SELECT * FROM "User" ORDER BY id')).rows,sessions:(await db.query('SELECT * FROM "Session" ORDER BY id')).rows,membership:(await db.query('SELECT * FROM "WorkspaceMembership"')).rows,selection:(await db.query('SELECT * FROM "SessionWorkspace"')).rows},before);
});
test('project preview is read-only, stale membership generation/role deny commit',opt,async()=>{
 await projectFixture();const p=await projectPreview();const n=(await db.query('SELECT count(*) FROM "PortalWorkspaceReceipt"')).rows[0].count;
 assert.equal(p.members.length,1);assert.equal((await db.query('SELECT count(*) FROM "PortalWorkspaceReceipt"')).rows[0].count,n);
 await apply('role','ADMIN');await assert.rejects(projectApply('EDITOR',p));
 await apply('role','MEMBER');await assert.rejects(projectApply('EDITOR',p));
 await apply('revoke',null);await assert.rejects(projectPreview());
 await apply('regrant');await assert.rejects(projectApply('EDITOR',p));
});
test('project foreign workspace, archived/deleted resource and inactive actor/target refuse',opt,async()=>{
 await projectFixture();
 for(const [sql,reset] of [
  [`UPDATE "Project" SET "workspaceId"='home'`,`UPDATE "Project" SET "workspaceId"='extra'`],
  [`UPDATE "Project" SET "archivedAt"=NOW()`,`UPDATE "Project" SET "archivedAt"=NULL`],
  [`UPDATE "Project" SET "deletedAt"=NOW()`,`UPDATE "Project" SET "deletedAt"=NULL`],
  [`UPDATE "User" SET "deactivatedAt"=NOW() WHERE id='target'`,`UPDATE "User" SET "deactivatedAt"=NULL WHERE id='target'`],
  [`UPDATE "User" SET "orgRole"='MEMBER' WHERE id='reviewer'`,`UPDATE "User" SET "orgRole"='SUPER_ADMIN' WHERE id='reviewer'`]]){await db.query(sql);await assert.rejects(projectPreview());await db.query(reset);}
});
test('project creator downgrade and last Leader removal are held',opt,async()=>{
 await projectFixture();await projectApply('EDITOR');
 await db.query(`INSERT INTO "ActionLog"(id,"actorId",channel,"projectId","targetType","targetId",action) VALUES ('creator','target','SCREEN','p','project','p','project.created')`);
 await assert.rejects(projectPreview('VIEWER'));await assert.rejects(projectPreview('EDITOR'));
 await projectApply('revoke');assert.equal((await projectPreview('inspect')).members.length,1);
 await db.query(`DELETE FROM "ActionLog" WHERE id='creator'`);await projectApply('EDITOR');
 await projectApply('LEADER');await assert.rejects(projectPreview('revoke'));await assert.rejects(projectPreview('VIEWER'));
 const roles=(await db.query(`SELECT "userId",role::text FROM "ProjectMember" ORDER BY "userId"`)).rows;
 assert.deepEqual(roles,[{userId:'reviewer',role:'EDITOR'},{userId:'target',role:'LEADER'}]);
});
test('project task handover is explicit; assigned and approval work is never silently changed',opt,async()=>{
 await projectFixture();await projectApply('EDITOR');
 await db.query(`INSERT INTO "Section"(id,"projectId",name,position) VALUES ('sec','p','Open',0);
 INSERT INTO "Task"(id,"workspaceId","projectId","sectionId",title,"assigneeId","createdById","updatedAt") VALUES ('task','extra','p','sec','Preserved','target','reviewer',NOW())`);
 const tasks=(await db.query('SELECT * FROM "Task"')).rows;
 await assert.rejects(projectPreview('VIEWER'));await assert.rejects(projectPreview('revoke'));
 assert.deepEqual((await db.query('SELECT * FROM "Task"')).rows,tasks);
});
test('project stale roster, config drift and replay cannot commit',opt,async()=>{
 await projectFixture();const old=await projectPreview();await projectApply('VIEWER');await assert.rejects(projectApply('EDITOR',old));
 const plan=await projectPreview('EDITOR'),requestId=randomUUID(),payload={...input(),project:'p',role:'EDITOR',operation:'apply',requestId,expected:plan};
 await assert.rejects(projectChange(db,projectPolicy,payload,()=>false));
 await projectChange(db,projectPolicy,payload);await assert.rejects(projectChange(db,projectPolicy,payload));
 assert.equal((await db.query('SELECT count(*) FROM "PortalWorkspaceReceipt" WHERE id=$1',[requestId])).rows[0].count,'1');
});
test('project audit failure rolls back membership and receipt together',opt,async()=>{
 await projectFixture();const plan=await projectPreview(),before=(await db.query('SELECT count(*) FROM "PortalWorkspaceReceipt"')).rows[0].count;
 await db.query(`CREATE FUNCTION reject_project_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='PORTAL_WORKSPACE_PROJECT_ROLE' THEN RAISE EXCEPTION 'synthetic audit fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_project_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION reject_project_audit()`);
 try{await assert.rejects(projectApply('EDITOR',plan));assert.equal((await db.query('SELECT count(*) FROM "ProjectMember" WHERE "userId"=\'target\'')).rows[0].count,'0');assert.equal((await db.query('SELECT count(*) FROM "PortalWorkspaceReceipt"')).rows[0].count,before);}
 finally{await db.query('DROP TRIGGER reject_project_audit ON "AuditLog"; DROP FUNCTION reject_project_audit()');}
});
test('project catalogue returns only pinned live projects in this workspace',opt,async()=>{
 await projectFixture();
 await db.query(`INSERT INTO "Project"(id,"workspaceId",name,"updatedAt") VALUES ('foreign-p','foreign','Foreign',NOW()),('hidden-p','extra','Not reviewed',NOW())`);
 const result=await projectPreview('list',{project:'catalogue'});assert.deepEqual(result.projects,[{id:'p',name:'Reviewed project'}]);
 await assert.rejects(projectPreview('EDITOR',{project:'hidden-p'}));
 await db.query(`UPDATE "Project" SET "archivedAt"=NOW() WHERE id='p'`);assert.deepEqual((await projectPreview('list',{project:'catalogue'})).projects,[]);
});

async function handoverFixture(){
 await projectFixture();await projectApply('EDITOR');
 await db.query(`INSERT INTO "User"(id,"workspaceId",email,name,"passwordHash","orgRole","emailVerifiedAt") VALUES ('taker','extra','taker@example.invalid','Taker','!synthetic!','MEMBER',NOW());
 INSERT INTO "ProjectMember"("projectId","userId",role) VALUES ('p','taker','EDITOR');
 INSERT INTO "Section"(id,"projectId",name,position) VALUES ('sec','p','Work',0);
 INSERT INTO "Task"(id,"workspaceId","projectId","sectionId",title,"assigneeId","approverId","createdById","updatedAt","completedAt","deletedAt") VALUES
 ('open','extra','p','sec','Open assigned work','target',NULL,'target',NOW(),NULL,NULL),
 ('waiting','extra','p','sec','Awaiting approval','target','target','target',NOW(),NULL,NULL),
 ('clear','extra','p','sec','Leader already holds','reviewer','target','target',NOW(),NULL,NULL),
 ('approval','extra','p','sec','Other holder','taker','target','target',NOW(),NULL,NULL),
 ('closed','extra','p','sec','Completed history','target','target','target',NOW(),NOW(),NULL),
 ('trash','extra','p','sec','Trashed history','target',NULL,'target',NOW(),NULL,NOW());
 INSERT INTO "TaskCollaborator"("taskId","userId") VALUES ('open','target'),('open','taker'),('closed','target');`);
}
const taskSnapshot=async()=> (await db.query('SELECT * FROM "Task" ORDER BY id')).rows;
test('handover applies native holder approval history and collaboration semantics atomically',opt,async()=>{
 await handoverFixture();const before=await taskSnapshot();const users=(await db.query('SELECT * FROM "User" ORDER BY id')).rows;
 const p=await projectPreview('VIEWER',{handoverTo:'taker'});assert.equal(p.handover.changes.length,5);
 const result=await projectApply('VIEWER',p,'taker');assert.deepEqual(result.handover,p.handover.changes);
 let after=await taskSnapshot();
 for(const row of after){const old=before.find(x=>x.id===row.id);const expected=p.handover.changes.find(x=>x.id===row.id);assert.deepEqual(row,{...old,...(expected?{assigneeId:expected.assigneeId,approverId:expected.approverId,updatedAt:row.updatedAt}:{})});}
 const byId=Object.fromEntries(after.map(x=>[x.id,x]));
 assert.equal(byId.open.assigneeId,'taker');assert.equal(byId.waiting.assigneeId,'reviewer');assert.equal(byId.waiting.approverId,'reviewer');
 assert.equal(byId.clear.approverId,null);assert.equal(byId.approval.approverId,'reviewer');assert.equal(byId.closed.assigneeId,'target');assert.equal(byId.closed.approverId,'reviewer');assert.equal(byId.trash.assigneeId,'target');
 assert.equal((await db.query(`SELECT count(*) FROM "TaskCollaborator" WHERE "userId"='target'`)).rows[0].count,'2');
 await projectApply('revoke');assert.equal((await db.query(`SELECT count(*) FROM "TaskCollaborator" WHERE "userId"='target'`)).rows[0].count,'0');
 assert.equal((await db.query(`SELECT count(*) FROM "TaskCollaborator" WHERE "userId"='taker'`)).rows[0].count,'1');
 assert.deepEqual(await taskSnapshot(),after);assert.deepEqual((await db.query('SELECT * FROM "User" ORDER BY id')).rows,users);
 assert.equal((await db.query(`SELECT count(*) FROM "Notification" WHERE "recipientId"='taker' AND type='TASKS_HANDED_OVER'`)).rows[0].count,'1');
});
test('handover missing self foreign viewer inactive and revoked-workspace recipients deny',opt,async()=>{
 await handoverFixture();const before=await taskSnapshot();
 for(const handoverTo of [null,'target','unrelated','missing'])await assert.rejects(projectPreview('revoke',{handoverTo}));
 for(const [sql,reset] of [
 [`UPDATE "ProjectMember" SET role='VIEWER' WHERE "userId"='taker'`,`UPDATE "ProjectMember" SET role='EDITOR' WHERE "userId"='taker'`],
 [`UPDATE "User" SET "deactivatedAt"=NOW() WHERE id='taker'`,`UPDATE "User" SET "deactivatedAt"=NULL WHERE id='taker'`],
 [`UPDATE "User" SET "emailVerifiedAt"=NULL WHERE id='taker'`,`UPDATE "User" SET "emailVerifiedAt"=NOW() WHERE id='taker'`],
 [`UPDATE "User" SET "workspaceId"='foreign' WHERE id='taker'`,`UPDATE "User" SET "workspaceId"='extra' WHERE id='taker'`]]){await db.query(sql);await assert.rejects(projectPreview('revoke',{handoverTo:'taker'}));await db.query(reset);}
 assert.deepEqual(await taskSnapshot(),before);
});
test('handover stale task recipient and collaboration proofs require fresh review',opt,async()=>{
 await handoverFixture();
 for(const sql of [`UPDATE "Task" SET title='Changed after review' WHERE id='open'`,`UPDATE "User" SET name='Changed taker' WHERE id='taker'`,`UPDATE "TaskCollaborator" SET "userId"="userId" WHERE "userId"='target'`]){
  const plan=await projectPreview('revoke',{handoverTo:'taker'});await db.query(sql);await assert.rejects(projectApply('revoke',plan,'taker'));
 }
 assert.equal((await db.query(`SELECT role::text FROM "ProjectMember" WHERE "userId"='target'`)).rows[0].role,'EDITOR');
});
test('handover audit fault rolls back tasks collaborations role notices and receipt',opt,async()=>{
 await handoverFixture();const tables=['Task','TaskCollaborator','ProjectMember','Notification','PortalWorkspaceReceipt'];
 const snapshot=async()=>{const r={};for(const t of tables)r[t]=(await db.query(`SELECT row_to_json(x)::text value FROM "${t}" x ORDER BY row_to_json(x)::text`)).rows;return r;};
 const before=await snapshot();
 await db.query(`CREATE FUNCTION reject_handover_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='PORTAL_WORKSPACE_PROJECT_ROLE' THEN RAISE EXCEPTION 'synthetic handover fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_handover_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION reject_handover_audit()`);
 try{await assert.rejects(projectApply('revoke',undefined,'taker'));assert.deepEqual(await snapshot(),before);}
 finally{await db.query('DROP TRIGGER reject_handover_audit ON "AuditLog"; DROP FUNCTION reject_handover_audit()');}
});

test('handover sees work committed while waiting for table locks before its snapshot',opt,async()=>{
 await handoverFixture();const plan=await projectPreview('revoke',{handoverTo:'taker'});
 const writer=new pg.Client(opts);await writer.connect();let injected=false;
 const locked={query:async(text,args)=>{
  if(!injected && text.startsWith('LOCK TABLE "ActionLog"')){
   injected=true;
   await writer.query(`INSERT INTO "Task"(id,"workspaceId","projectId","sectionId",title,"assigneeId","createdById","updatedAt") VALUES ('late','extra','p','sec','Concurrent new task','target','target',NOW())`);
  }
  return db.query(text,args);
 }};
 try{
  await assert.rejects(projectChange(locked,projectPolicy,{...input(),project:'p',role:'revoke',handoverTo:'taker',operation:'apply',requestId:randomUUID(),expected:plan}));
  assert(injected);assert.equal((await db.query(`SELECT role::text FROM "ProjectMember" WHERE "userId"='target'`)).rows[0].role,'EDITOR');
  assert.equal((await db.query(`SELECT "assigneeId" FROM "Task" WHERE id='late'`)).rows[0].assigneeId,'target');
 }finally{await writer.end();}
});
