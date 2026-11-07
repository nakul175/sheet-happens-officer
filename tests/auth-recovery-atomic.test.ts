import { beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({transaction:vi.fn(),consume:vi.fn(),hash:vi.fn(),usable:vi.fn()}));
vi.mock('@/lib/db',()=>({db:{$transaction:m.transaction}}));
vi.mock('@/lib/auth',()=>({consumeToken:m.consume,hashPassword:m.hash,usableToken:m.usable,clientIp:()=>null,clientAgent:()=>null}));
vi.mock('next/server',()=>({connection:vi.fn()}));
import { POST as reset } from '@/app/api/auth/reset-password/route';
import { POST as verify } from '@/app/api/auth/verify/route';
const request=(kind:string)=>new Request('http://localhost/api/auth/'+kind,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'a'.repeat(43),password:'SyntheticPassword123!',confirm:'SyntheticPassword123!'})});
const tx={user:{findUniqueOrThrow:vi.fn(),update:vi.fn()},session:{updateMany:vi.fn()},loginAttempt:{deleteMany:vi.fn()},auditLog:{create:vi.fn()}};
beforeEach(()=>{
 vi.resetAllMocks();m.usable.mockResolvedValue({id:'token'});m.hash.mockResolvedValue('synthetic-hash');m.consume.mockResolvedValue('user');tx.user.findUniqueOrThrow.mockResolvedValue({email:'synthetic@example.invalid'});
 m.transaction.mockImplementation(fn=>fn(tx));
});
it('hash failure occurs before any token claim or transaction',async()=>{
 m.hash.mockRejectedValue(Error('injected hash failure'));
 expect((await reset(request('reset-password'))).status).toBe(500);
 expect(m.consume).not.toHaveBeenCalled();expect(m.transaction).not.toHaveBeenCalled();
});
it('reset puts claim, password, sessions, lockout and audit in the same transaction',async()=>{
 expect((await reset(request('reset-password'))).status).toBe(200);
 expect(m.consume).toHaveBeenCalledWith('a'.repeat(43),'RESET',tx);
 expect(tx.user.update).toHaveBeenCalledWith({where:{id:'user'},data:{passwordHash:'synthetic-hash',tempPasswordAt:null}});
 expect(tx.session.updateMany).toHaveBeenCalledWith({where:{userId:'user',revokedAt:null},data:{revokedAt:expect.any(Date)}});
 expect(tx.loginAttempt.deleteMany).toHaveBeenCalledWith({where:{email:'synthetic@example.invalid'}});
 expect(tx.auditLog.create).toHaveBeenCalled();
});
for(const [name,route] of [['RESET',reset],['VERIFY',verify]] as const){
 it(`${name} refuses a spent token before changing the user`,async()=>{
  m.consume.mockResolvedValue(null);expect((await route(request(name))).status).toBe(400);expect(tx.user.update).not.toHaveBeenCalled();
 });
 it(`${name} propagates user-write failure out of transaction to cause rollback`,async()=>{
  tx.user.update.mockRejectedValue(Error('injected write failure'));
  expect((await route(request(name))).status).toBe(500);expect(tx.auditLog.create).not.toHaveBeenCalled();
 });
 it(`${name} does not hide audit-write failure`,async()=>{
  tx.auditLog.create.mockRejectedValue(Error('injected audit failure'));
  expect((await route(request(name))).status).toBe(500);
 });
}
it('verification claims and changes verification in its transaction',async()=>{
 expect((await verify(request('verify'))).status).toBe(200);
 expect(m.consume).toHaveBeenCalledWith('a'.repeat(43),'VERIFY',tx);
 expect(tx.user.update).toHaveBeenCalledWith({where:{id:'user'},data:{emailVerifiedAt:expect.any(Date)}});
});

it('rejects an unknown or expired reset link before expensive hashing',async()=>{
 m.usable.mockResolvedValue(null);
 expect((await reset(request('reset-password'))).status).toBe(400);
 expect(m.hash).not.toHaveBeenCalled();expect(m.transaction).not.toHaveBeenCalled();
});
