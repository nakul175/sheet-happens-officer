import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const h=vi.hoisted(()=>({jar:new Map<string,string>(),set:vi.fn(),audit:vi.fn(),attach:vi.fn(),active:vi.fn(async()=>true),find:vi.fn(async()=>({id:'fixture-user',deactivatedAt:null,emailVerifiedAt:new Date(),tempPasswordAt:null})),grant:vi.fn(async(_config:unknown,_url:URL,_checks:Record<string,string>)=>({claims:()=>({sub:'fixture-sub',sho_user_id:'fixture-user',aplyd_session_uid:'fixture-session',sho_source_session_id:'fixture-source',email_verified:true})}))}));
vi.mock('next/headers',()=>({cookies:async()=>({get:(k:string)=>h.jar.has(k)?{value:h.jar.get(k)}:undefined,set:(k:string,v:string,o:unknown)=>{h.jar.set(k,v);h.set(k,v,o);}})}));
vi.mock('openid-client',()=>({randomState:()=> 's'.repeat(43),randomNonce:()=> 'n'.repeat(43),randomPKCECodeVerifier:()=> 'v'.repeat(43),calculatePKCECodeChallenge:async()=> 'challenge',buildAuthorizationUrl:(_c:unknown,p:Record<string,string>)=>new URL('https://accounts.aplyd.org/authorize?'+new URLSearchParams(p)),authorizationCodeGrant:h.grant}));
vi.mock('@/lib/central-client',async(importOriginal)=>({...await importOriginal<typeof import('@/lib/central-client')>(),centralClient:vi.fn(async()=>({}))}));
vi.mock('@/lib/db',()=>({db:{user:{findUnique:h.find}}}));
vi.mock('@/lib/auth',()=>({audit:h.audit}));
vi.mock('@/lib/attach-central-session',()=>({attachCentralSession:h.attach}));
vi.mock('@/lib/central-status',()=>({centralSessionActive:h.active}));
import {GET as start} from '@/app/api/auth/aplyd/start/route';
import {GET as callback} from '@/app/api/auth/aplyd/callback/route';
import {FLOW_COOKIE,readFlow,sealFlow,SHO_ORIGIN,CENTRAL_CALLBACK} from '@/lib/central-client';
const oldSecret=process.env.APLYD_ACCOUNTS_CLIENT_SECRET;const oldFlag=process.env.SIGNIN_RETURN_TO;
const req=(path:string)=>new Request(SHO_ORIGIN+path);
beforeEach(()=>{vi.clearAllMocks();h.jar.clear();h.active.mockResolvedValue(true);process.env.APLYD_ACCOUNTS_CLIENT_SECRET='scoped4-synthetic-unit-fixture-not-a-provider-secret';process.env.SIGNIN_RETURN_TO='on';});
afterEach(()=>{if(oldSecret===undefined)delete process.env.APLYD_ACCOUNTS_CLIENT_SECRET;else process.env.APLYD_ACCOUNTS_CLIENT_SECRET=oldSecret;if(oldFlag===undefined)delete process.env.SIGNIN_RETURN_TO;else process.env.SIGNIN_RETURN_TO=oldFlag;});
async function flowFor(next?:string){const r=await start(req('/api/auth/aplyd/start'+(next?'?next='+encodeURIComponent(next):'')));expect(r.status).toBe(302);return readFlow(h.jar.get(FLOW_COOKIE)!);}
describe('scoped4 OIDC bounded return path',()=>{
 it('carries a safe encoded query through encrypted flow and returns after session attachment',async()=>{const path='/projects?q=a%20b';const f=await flowFor(path);expect(f.returnPath).toBe(path);const result=await callback(req('/api/auth/aplyd/callback?code=fixture&state='+f.state));expect(result.headers.get('location')).toBe(SHO_ORIGIN+path);expect(h.attach).toHaveBeenCalledWith('fixture-source','fixture-user','fixture-sub','fixture-session');expect(h.grant.mock.calls[0][1].href).toContain(CENTRAL_CALLBACK);expect(h.grant.mock.calls[0][2]).toEqual({pkceCodeVerifier:f.verifier,expectedState:f.state,expectedNonce:f.nonce});expect(h.set).toHaveBeenCalledWith(FLOW_COOKIE,'',expect.objectContaining({maxAge:0,httpOnly:true,secure:true,sameSite:'lax',path:'/'}));});
 it.each(['https://example.invalid/x','//example.invalid/x','/\\example.invalid','/tasks/a\r\nx'])('refuses unsafe requested next %j',async(next)=>{expect((await flowFor(next)).returnPath).toBeUndefined();});
 it('revalidates a signed unsafe return path at callback',async()=>{const f=await flowFor();h.jar.set(FLOW_COOKIE,sealFlow({...f,returnPath:'https://example.invalid/'}));const r=await callback(req('/api/auth/aplyd/callback'));expect(r.headers.get('location')).toBe(SHO_ORIGIN+'/');});
 it('preserves old flow cookies without a return path',async()=>{await flowFor();const r=await callback(req('/api/auth/aplyd/callback'));expect(r.headers.get('location')).toBe(SHO_ORIGIN+'/');});
 it('ignores next when flag off and does not redirect from existing pending flow when disabled',async()=>{const f=await flowFor('/projects');process.env.SIGNIN_RETURN_TO='off';expect((await flowFor('/tasks/t')).returnPath).toBeUndefined();h.jar.set(FLOW_COOKIE,sealFlow(f));expect((await callback(req('/api/auth/aplyd/callback'))).headers.get('location')).toBe(SHO_ORIGIN+'/');});
 it('allows bounded long safe paths within encrypted cookie limit',async()=>{const path='/tasks/'+'x'.repeat(1800);expect((await flowFor(path)).returnPath).toBe(path);expect(h.jar.get(FLOW_COOKIE)!.length).toBeLessThanOrEqual(4096);});
 it('falls back safely when a canonical Unicode path would exceed cookie budget',async()=>{expect((await flowFor('/'+'日'.repeat(800))).returnPath).toBeUndefined();expect(h.jar.get(FLOW_COOKIE)!.length).toBeLessThan(3801);});
 it('rejects expired or tampered flows before session attachment',async()=>{const f=await flowFor('/projects');h.jar.set(FLOW_COOKIE,sealFlow({...f,expires:Date.now()-1}));expect((await callback(req('/api/auth/aplyd/callback'))).status).toBe(400);expect(h.attach).not.toHaveBeenCalled();expect(h.grant).not.toHaveBeenCalled();});
 it('still refuses an inactive central session',async()=>{await flowFor('/projects');h.active.mockResolvedValue(false);expect((await callback(req('/api/auth/aplyd/callback'))).status).toBe(403);expect(h.attach).not.toHaveBeenCalled();});
});
