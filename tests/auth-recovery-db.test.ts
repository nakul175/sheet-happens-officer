// Real PostgreSQL regression. CI owns a disposable localhost sho_test database.
// Never point this file at a shared/staging/production database.
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { getOrCreateWorkspace } from '@/lib/workspace';
import { AuthMailLimitError, consumeToken, hashToken, issueTokenAndSend } from '@/lib/auth';
vi.mock('next/server',()=>({connection:vi.fn()}));
const id='recovery-'+randomUUID();
let safe=false;
let workspaceId:string;
beforeAll(async()=>{
 const u=new URL(process.env.DATABASE_URL??'');
 if(!['localhost','127.0.0.1'].includes(u.hostname)||u.pathname!='/sho_test')throw Error('LOCAL_DISPOSABLE_SHO_TEST_REQUIRED');
 safe=true;
 workspaceId=((await db.workspace.findFirst())??(await db.workspace.create({data:{name:'Synthetic recovery test'}}))).id;
 await db.user.create({data:{id,workspaceId,name:'Synthetic recovery',email:id+'@example.invalid',passwordHash:'unused'}});
});
beforeEach(async()=>{
 await db.authToken.deleteMany({where:{userId:id}});
 await db.auditLog.deleteMany({where:{actorId:id,event:'AUTH_EMAIL_DELIVERY'}});
});
afterAll(async()=>{
 if(!safe)return;
 await db.auditLog.deleteMany({where:{actorId:id}});await db.user.deleteMany({where:{id}});await db.$disconnect();
});
for(const type of ['RESET','VERIFY'] as const){
 it(`${type}: real transaction rollback preserves link after account write fails`,async()=>{
  const raw=await issueTokenAndSend(id,type,async()=>{});
  await expect(db.$transaction(async tx=>{
   expect(await consumeToken(raw,type,tx)).toBe(id);
   await tx.user.update({where:{id:'nonexistent-'+id},data:{name:'will fail'}});
  })).rejects.toBeDefined();
  expect((await db.authToken.findUniqueOrThrow({where:{tokenHash:hashToken(raw)}})).usedAt).toBeNull();
  expect(await db.$transaction(tx=>consumeToken(raw,type,tx))).toBe(id);
 });
 it(`${type}: concurrent claim has exactly one winner`,async()=>{
  const raw=await issueTokenAndSend(id,type,async()=>{});
  const result=await Promise.all([db.$transaction(tx=>consumeToken(raw,type,tx)),db.$transaction(tx=>consumeToken(raw,type,tx))]);
  expect(result.filter(x=>x===id)).toHaveLength(1);expect(result.filter(x=>x===null)).toHaveLength(1);
 });
 it(`${type}: reversed successful mail completion leaves latest row usable`,async()=>{
  let finish!:()=>void;
  const older=issueTokenAndSend(id,type,()=>new Promise<void>(r=>{finish=r;}));
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
  // Force distinct creation time in this real-DB test; equal times are covered by the focused ordering test.
  await db.authToken.updateMany({where:{userId:id,type,usedAt:null},data:{createdAt:new Date(0)}});
  const newer=await issueTokenAndSend(id,type,async()=>{});
  finish();await older;
  expect(await consumeToken(newer,type)).toBe(id);
 });
}

it('concurrent real bootstrap transactions converge on the sole workspace',async()=>{
 const rows=await Promise.all(Array.from({length:12},()=>getOrCreateWorkspace()));
 expect(new Set(rows.map(r=>r.id))).toEqual(new Set([workspaceId]));
 expect(await db.workspace.count()).toBe(1);
});

for(const type of ['RESET','VERIFY'] as const){
 it(`${type}: eight concurrent successful requests reserve at most three sends`,async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let sends=0;
  const pending=Array.from({length:8},()=>issueTokenAndSend(id,type,async()=>{sends++;await gate;}));
  const settled=Promise.allSettled(pending);
  try{await vi.waitFor(()=>expect(sends).toBe(3));}finally{release();}
  const results=await settled;
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(3);
  expect(results.filter(r=>r.status==='rejected'&&r.reason instanceof AuthMailLimitError)).toHaveLength(5);
  expect(await db.authToken.count({where:{userId:id,type}})).toBe(3);
 });
 it(`${type}: fast concurrent provider failures are capped and preserve an earlier link`,async()=>{
  const prior=await issueTokenAndSend(id,type,async()=>{});let sends=0;
  // A burst may hit the pending-send cap before failures settle. A second burst
  // proves the released pending slots cannot bypass the persistent failure cap.
  for(let burst=0;burst<2;burst++){
   const results=await Promise.allSettled(Array.from({length:8},()=>issueTokenAndSend(id,type,async()=>{sends++;throw Error('synthetic provider failure');})));
   expect(results.every(r=>r.status==='rejected')).toBe(true);
  }
  expect(sends).toBe(3);
  expect(await db.authToken.count({where:{userId:id,type}})).toBe(1);
  expect(await consumeToken(prior,type)).toBe(id);
  expect(await db.auditLog.count({where:{actorId:id,event:'AUTH_EMAIL_DELIVERY',data:{path:['result'],equals:'FAILED'}}})).toBe(3);
 });
}
