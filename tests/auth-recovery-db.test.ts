// Real PostgreSQL regression. CI owns a disposable localhost sho_test database.
// Never point this file at a shared/staging/production database.
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { consumeToken, hashToken, issueTokenAndSend } from '@/lib/auth';
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
afterAll(async()=>{
 if(!safe)return;
 await db.user.deleteMany({where:{id}});await db.$disconnect();
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
