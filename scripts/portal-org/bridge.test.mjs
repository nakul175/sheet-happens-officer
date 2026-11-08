import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {changeOrgRole} from './bridge.mjs';
const enabled=!!process.env.SHO_ORG_TEST_DATABASE_URL;
const policy={enabled:true,workspace:'w',reviewers:['reviewer'],protectedEmails:['protected@example.invalid'],reference:'isolated-reviewed-policy',configDigest:'a'.repeat(64)};
let db;
const opts={connectionString:process.env.SHO_ORG_TEST_DATABASE_URL,connectionTimeoutMillis:4000,
  ssl:process.env.SHO_ORG_TEST_CA?{ca:readFileSync(process.env.SHO_ORG_TEST_CA,'utf8'),servername:'db'}:undefined};
before(async()=>{if(!enabled)return;db=new pg.Client(opts);await db.connect();
 await db.query(`CREATE TYPE "OrgRole" AS ENUM ('MEMBER','ADMIN','SUPER_ADMIN');
 CREATE TABLE "User" (id text PRIMARY KEY,"workspaceId" text,email text,"orgRole" "OrgRole","emailVerifiedAt" timestamp,"deactivatedAt" timestamp);
 CREATE TABLE "AuditLog" (id text PRIMARY KEY,"actorId" text,event text,"targetId" text,data jsonb,"createdAt" timestamp);
 CREATE TABLE "Notification" (id text PRIMARY KEY,"recipientId" text,"actorId" text,type text,data jsonb,"createdAt" timestamp);
 CREATE TABLE "ProjectMember" ("projectId" text,"userId" text,role text);
 CREATE TABLE "WorkData" (id text,body text);`);
 await db.query(readFileSync(new URL('../../prisma/migrations/20261108120000_portal_org_receipts/migration.sql',import.meta.url),'utf8'));
});
beforeEach(async()=>{if(!enabled)return;await db.query(`TRUNCATE "User","AuditLog","Notification","PortalOrgRoleReceipt","ProjectMember","WorkData";
 INSERT INTO "User" VALUES ('reviewer','w','reviewer@example.invalid','SUPER_ADMIN',NOW(),NULL),('target','w','target@example.invalid','MEMBER',NOW(),NULL),('other','w','other@example.invalid','MEMBER',NOW(),NULL);
 INSERT INTO "ProjectMember" VALUES ('p','target','VIEWER'),('p','other','LEADER'); INSERT INTO "WorkData" VALUES ('content','preserve me');`);});
after(async()=>{await db?.end()});
const preview=(c=db,p=policy)=>changeOrgRole(c,p,{operation:'preview',actor:'reviewer',target:'target'});
const apply=(expected,role='ADMIN',extra={})=>changeOrgRole(db,policy,{operation:'apply',actor:'reviewer',target:'target',expected,role,requestId:randomUUID(),...extra});
test('default off denies before I/O',async()=>{await assert.rejects(changeOrgRole({query(){throw Error('must not read')}},{...policy,enabled:false},{operation:'preview',actor:'reviewer',target:'target'}));});
test('exact native Admin grant and Member downgrade preserve project roles/content',{skip:!enabled},async()=>{
 const before=await db.query('SELECT * FROM "ProjectMember" ORDER BY "userId"');const p=await preview();
 assert.equal((await db.query('SELECT count(*) FROM "PortalOrgRoleReceipt"')).rows[0].count,'0');
 const granted=await apply(p);assert.equal(granted.after.role,'ADMIN');assert.equal(granted.changed,true);
 const down=await apply(await preview(),'MEMBER');assert.equal(down.after.role,'MEMBER');
 assert.deepEqual((await db.query('SELECT * FROM "ProjectMember" ORDER BY "userId"')).rows,before.rows);
 assert.equal((await db.query('SELECT body FROM "WorkData"')).rows[0].body,'preserve me');
 assert.equal((await db.query('SELECT count(*) FROM "AuditLog"')).rows[0].count,'2');
 assert.equal((await db.query('SELECT count(*) FROM "Notification"')).rows[0].count,'2');
});
test('native protected and inactive identities, cross-workspace and ordinary reviewer denied',{skip:!enabled},async()=>{
 for(const sql of [`UPDATE "User" SET "orgRole"='SUPER_ADMIN' WHERE id='target'`,`UPDATE "User" SET email='protected@example.invalid' WHERE id='target'`,`UPDATE "User" SET "deactivatedAt"=NOW() WHERE id='target'`,`UPDATE "User" SET "emailVerifiedAt"=NULL WHERE id='target'`,`UPDATE "User" SET "workspaceId"='foreign' WHERE id='target'`,`UPDATE "User" SET "orgRole"='ADMIN' WHERE id='reviewer'`]){
  await db.query('BEGIN');await db.query(sql);
  // Preview itself opens its transaction; use an outer savepoint-free reset after rejection.
  await db.query('COMMIT');await assert.rejects(preview());
  await db.query(`UPDATE "User" SET email=id||'@example.invalid',"workspaceId"='w',"emailVerifiedAt"=NOW(),"deactivatedAt"=NULL,"orgRole"=CASE WHEN id='reviewer' THEN 'SUPER_ADMIN'::"OrgRole" ELSE 'MEMBER'::"OrgRole" END`);
 }
 await assert.rejects(preview(db,{...policy,reviewers:[]}));
});
test('stale plan, unknown role, self and replay rejected',{skip:!enabled},async()=>{
 const p=await preview();await db.query(`UPDATE "User" SET "orgRole"='ADMIN' WHERE id='target'`);await assert.rejects(apply(p));
 await assert.rejects(apply(await preview(),'SUPER_ADMIN'));
 await assert.rejects(changeOrgRole(db,policy,{operation:'preview',actor:'reviewer',target:'reviewer'}));
 const requestId=randomUUID();await apply(await preview(),'MEMBER',{requestId});await assert.rejects(apply(await preview(),'ADMIN',{requestId}));
});
test('receipt/audit failure or changed runtime policy rolls back native role',{skip:!enabled},async()=>{
 let n=0;const p=await preview();await assert.rejects(changeOrgRole(db,policy,{operation:'apply',actor:'reviewer',target:'target',expected:p,role:'ADMIN',requestId:randomUUID()},()=>++n===1));
 assert.equal((await preview()).role,'MEMBER');assert.equal((await db.query('SELECT count(*) FROM "PortalOrgRoleReceipt"')).rows[0].count,'0');
 await db.query('ALTER TABLE "AuditLog" ADD CONSTRAINT reject_fixture CHECK (false)');await assert.rejects(apply(await preview()));
 assert.equal((await preview()).role,'MEMBER');await db.query('ALTER TABLE "AuditLog" DROP CONSTRAINT reject_fixture');
});
test('concurrent exact plans have one winner and one receipt',{skip:!enabled},async()=>{
 const other=new pg.Client(opts);await other.connect();try{
 const p=await preview();const attempts=await Promise.allSettled([db,other].map(c=>changeOrgRole(c,policy,{operation:'apply',actor:'reviewer',target:'target',expected:p,role:'ADMIN',requestId:randomUUID()})));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal((await db.query('SELECT count(*) FROM "PortalOrgRoleReceipt"')).rows[0].count,'1');
 }finally{await other.end()}
});
