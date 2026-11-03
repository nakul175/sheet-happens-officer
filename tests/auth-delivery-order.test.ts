import { beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({create:vi.fn(),updateMany:vi.fn(),delete:vi.fn(),count:vi.fn(),transaction:vi.fn(),lock:vi.fn(),receiptCreate:vi.fn(),receiptUpdate:vi.fn(),receiptCount:vi.fn()}));
vi.mock('@/lib/db',()=>({db:{authToken:m,$transaction:m.transaction}}));
vi.mock('next/headers',()=>({cookies:vi.fn()}));
vi.mock('next/server',()=>({connection:vi.fn()}));
import { issueTokenAndSend, hashToken } from '@/lib/auth';
type Row={id:string;userId:string;type:string;tokenHash:string;createdAt:Date;usedAt:Date|null};
let rows:Row[];
beforeEach(()=>{
 vi.resetAllMocks();rows=[];
 m.count.mockResolvedValue(0);m.receiptCount.mockResolvedValue(0);m.receiptCreate.mockResolvedValue({id:'receipt'});
 m.transaction.mockImplementation(fn=>fn({$queryRaw:m.lock,authToken:m,auditLog:{count:m.receiptCount,create:m.receiptCreate,update:m.receiptUpdate}}));
 m.create.mockImplementation(async({data})=>{const row={...data,id:`row-${rows.length}`,createdAt:new Date(0),usedAt:null};rows.push(row);return row;});
 m.delete.mockImplementation(async({where})=>{rows=rows.filter(r=>r.id!==where.id);});
 m.updateMany.mockImplementation(async({where,data})=>{let count=0;for(const r of rows){
  const older=where.OR.some((o:{createdAt:Date|{lt:Date};id?:{lt:string}})=>o.createdAt instanceof Date?r.createdAt.getTime()===o.createdAt.getTime()&&r.id<o.id!.lt:r.createdAt<o.createdAt.lt);
  if(r.userId===where.userId&&r.type===where.type&&!r.usedAt&&older){r.usedAt=data.usedAt;count++;}
 }return{count};});
});
for(const type of ['RESET','VERIFY'] as const)for(const newerFirst of [true,false])for(const sameTime of [true,false]){
 it(`${type}: newest delivered link survives ${newerFirst?'reverse':'forward'} delivery with ${sameTime?'equal':'different'} timestamps`,async()=>{
  let a!:()=>void,b!:()=>void;
  const pa=issueTokenAndSend('user',type,()=>new Promise<void>(r=>{a=r;}));
  await vi.waitFor(()=>expect(a).toBeTypeOf('function'));
  const pb=issueTokenAndSend('user',type,()=>new Promise<void>(r=>{b=r;}));
  await vi.waitFor(()=>expect(b).toBeTypeOf('function'));
  if(!sameTime)rows[1].createdAt=new Date(1000);
  if(newerFirst){b();await pb;a();await pa;}else{a();await pa;b();await pb;}
  expect(rows.filter(r=>!r.usedAt).map(r=>r.tokenHash)).toEqual([hashToken(await pb)]);
 });
}
for(const type of ['RESET','VERIFY'] as const)it(`${type}: failed newer delivery leaves previous delivered link usable`,async()=>{
 const first=await issueTokenAndSend('user',type,async()=>{});
 await expect(issueTokenAndSend('user',type,async()=>{throw Error('synthetic delivery failure');})).rejects.toThrow('synthetic delivery failure');
 expect(rows).toHaveLength(1);expect(rows[0].tokenHash).toBe(hashToken(first));expect(rows[0].usedAt).toBeNull();
});
