import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({currentUser:vi.fn(),currentSessionId:vi.fn(),transaction:vi.fn(),lock:vi.fn(),session:vi.fn(),member:vi.fn(),clear:vi.fn(),save:vi.fn()}));
vi.mock('next/server',()=>({connection:vi.fn()}));
vi.mock('@/lib/auth',()=>({currentUser:m.currentUser,currentSessionId:m.currentSessionId}));
vi.mock('@/lib/db',()=>({db:{$transaction:m.transaction}}));
import {POST} from '@/app/api/workspaces/route';
const req=(body:unknown,origin:string|null='https://sho.fixture.invalid')=>new Request('http://127.0.0.1/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('SHO_MULTI_WORKSPACE_ENABLED','true');vi.stubEnv('APP_URL','https://sho.fixture.invalid');vi.stubEnv('DATABASE_URL','postgres://fixture:fixture@127.0.0.1/isolated?schema=preview');
 m.currentUser.mockResolvedValue({id:'person',workspaceId:'home'});m.currentSessionId.mockResolvedValue('session');
 m.session.mockResolvedValue({userId:'person',revokedAt:null,expiresAt:new Date(Date.now()+60000),user:{workspaceId:'home',deactivatedAt:null,emailVerifiedAt:new Date()}});
 m.member.mockResolvedValue({role:'MEMBER',generation:7,revokedAt:null});
 m.transaction.mockImplementation(async f=>f({$queryRaw:m.lock,session:{findUnique:m.session},workspaceMembership:{findUnique:m.member},sessionWorkspace:{deleteMany:m.clear,upsert:m.save}}));
});
afterEach(()=>vi.unstubAllEnvs());
it('explicit same-origin switch pins current membership generation under session/user/member locks',async()=>{
 expect((await POST(req({workspaceId:'extra'}))).status).toBe(200);
 expect(m.currentUser).toHaveBeenCalledWith({workspaceNeutral:true});expect(m.lock).toHaveBeenCalledTimes(3);
 expect(m.save.mock.calls[0][0].create).toEqual({sessionId:'session',userId:'person',workspaceId:'extra',generation:7});
 expect(m.transaction.mock.calls[0][1]).toMatchObject({isolationLevel:'Serializable',timeout:8000});
});
it('missing or foreign Origin and client-supplied authority are rejected before mutation',async()=>{
 for(const origin of [null,'https://foreign.invalid'])expect((await POST(req({workspaceId:'extra'},origin))).status).toBe(403);
 expect((await POST(req({workspaceId:'extra',role:'ADMIN'}))).status).toBe(400);expect(m.transaction).not.toHaveBeenCalled();
});
it('revoked expired foreign or disabled native sessions cannot switch',async()=>{
 for(const change of [{revokedAt:new Date()},{expiresAt:new Date(0)},{userId:'someone-else'},{user:{workspaceId:'home',deactivatedAt:new Date(),emailVerifiedAt:new Date()}}]){
  m.session.mockResolvedValue({userId:'person',revokedAt:null,expiresAt:new Date(Date.now()+60000),user:{workspaceId:'home',deactivatedAt:null,emailVerifiedAt:new Date()},...change});
  expect((await POST(req({workspaceId:'extra'}))).status).toBe(401);
 }
 expect(m.save).not.toHaveBeenCalled();
});
it('unknown revoked or invalid extra membership never becomes session authority',async()=>{
 for(const member of [null,{role:'MEMBER',generation:1,revokedAt:new Date()},{role:'SUPER_ADMIN',generation:1,revokedAt:null}]){
  m.member.mockResolvedValue(member);expect((await POST(req({workspaceId:'extra'}))).status).toBe(403);
 }
 expect(m.save).not.toHaveBeenCalled();
});
it('home recovery removes only this session selection without changing account or other sessions',async()=>{
 expect((await POST(req({workspaceId:'home'}))).status).toBe(200);expect(m.clear).toHaveBeenCalledWith({where:{sessionId:'session'}});expect(m.save).not.toHaveBeenCalled();
});
it('default-off denies before authenticating or mutating',async()=>{
 vi.stubEnv('SHO_MULTI_WORKSPACE_ENABLED','false');expect((await POST(req({workspaceId:'extra'}))).status).toBe(404);expect(m.currentUser).not.toHaveBeenCalled();expect(m.transaction).not.toHaveBeenCalled();
});
