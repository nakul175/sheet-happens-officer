// Real local HTTP/DB suite flow; redirects are inspected, never followed off-host.
import { afterAll,beforeAll,expect,it } from 'vitest';
import { createHash,randomBytes } from 'node:crypto';
import { db } from '@/lib/db';
import { account,BASE,type Account } from './helpers';
const accounts:Account[]=[];
let safe=false;
const callback=(client:string)=>client==='accounts'?'https://accounts.aplyd.org/bridge/callback':'https://bugoff.aplyd.org/api/auth/callback/aplyd';
const secret=(client:string)=>process.env[client==='accounts'?'SUITE_ACCOUNTS_CLIENT_SECRET':'SUITE_BUGOFF_CLIENT_SECRET']!;
beforeAll(()=>{
 const database=new URL(process.env.DATABASE_URL??''),app=new URL(BASE);
 if(![database,app].every(u=>['localhost','127.0.0.1'].includes(u.hostname))||database.pathname!='/sho_test')throw Error('LOCAL_DISPOSABLE_SUITE_TEST_REQUIRED');
 for(const client of ['accounts','bugoff'])expect(secret(client)).toMatch(/^ci-synthetic-.*-only-/);
 safe=true;
});
afterAll(async()=>{
 if(!safe)return;
 const ids=accounts.map(a=>a.id),emails=accounts.map(a=>a.email);
 await db.suiteGrant.deleteMany({where:{userId:{in:ids}}});
 await db.auditLog.deleteMany({where:{actorId:{in:ids}}});
 await db.loginAttempt.deleteMany({where:{email:{in:emails}}});
 await db.user.deleteMany({where:{id:{in:ids}}});
});
async function issue(client:string){
 const who=await account('zzsuite'+client);accounts.push(who);
 const verifier=randomBytes(32).toString('base64url'),state=randomBytes(24).toString('base64url');
 const query=new URLSearchParams({client_id:client,redirect_uri:callback(client),response_type:'code',code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),state});
 const response=await fetch(BASE+'/api/suite/authorize?'+query,{headers:{cookie:who.c.cookie},redirect:'manual'});
 expect(response.status).toBe(302);expect(response.headers.get('cache-control')).toBe('no-store');
 const location=new URL(response.headers.get('location')!);expect(location.origin+location.pathname).toBe(callback(client));expect(location.searchParams.get('state')).toBe(state);
 const code=location.searchParams.get('code')!;expect(code).toMatch(/^[\w-]{43}$/);
 return{who,client,verifier,code};
}
function redeem(g:Awaited<ReturnType<typeof issue>>,extra:Record<string,string>={}){
 return fetch(BASE+'/api/suite/token',{method:'POST',body:new URLSearchParams({client_id:g.client,client_secret:secret(g.client),grant_type:'authorization_code',redirect_uri:callback(g.client),code_verifier:g.verifier,code:g.code,...extra}),redirect:'manual'});
}
const userinfo=(token:string)=>fetch(BASE+'/api/suite/userinfo',{headers:{authorization:'Bearer '+token},redirect:'manual'});
for(const client of ['accounts','bugoff'])it(`${client}: PKCE exchange, identity and replay denial`,async()=>{
 const g=await issue(client),response=await redeem(g);expect(response.status).toBe(200);
 const token=await response.json();expect(token.expires_in).toBe(60);
 const info=await userinfo(token.access_token);expect(info.status).toBe(200);const body=await info.json();expect(body.sub).toBe(g.who.id);expect(body.email).toBe(g.who.email);
 if(client==='accounts')expect(body.source_session_id).toBeTypeOf('string');else expect(body.source_session_id).toBeUndefined();
 expect((await redeem(g)).status).toBe(400);
});
it('wrong verifier, callback and client secret do not spend a valid code',async()=>{
 const g=await issue('accounts');
 const badInputs:Record<string,string>[]=[{code_verifier:'w'.repeat(43)},{redirect_uri:'https://evil.invalid/cb'},{client_secret:'wrong'}];
 for(const bad of badInputs)expect((await redeem(g,bad)).status).toBe(bad.client_secret?401:400);
 expect((await redeem(g)).status).toBe(200);
});
it('concurrent code redemption has one winner',async()=>{
 const g=await issue('accounts'),responses=await Promise.all([redeem(g),redeem(g)]);
 expect(responses.map(r=>r.status).sort()).toEqual([200,400]);
});
it('session revocation invalidates userinfo and the Accounts status contract',async()=>{
 const g=await issue('accounts'),token=await(await redeem(g)).json();
 const identity=await(await userinfo(token.access_token)).json();
 const status=()=>fetch(BASE+'/api/suite/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_id:'accounts',client_secret:secret('accounts'),user_id:g.who.id,source_session_id:identity.source_session_id})});
 expect(await(await status()).json()).toMatchObject({active:true,sub:g.who.id});
 expect((await g.who.c.post('/api/auth/signout')).status).toBe(204);
 expect((await userinfo(token.access_token)).status).toBe(401);
 expect(await(await status()).json()).toEqual({active:false});
});
it('oversized bodies and unauthenticated userinfo are rejected',async()=>{
 expect((await fetch(BASE+'/api/suite/token',{method:'POST',body:'x'.repeat(8193)})).status).toBe(413);
 expect((await fetch(BASE+'/api/suite/status',{method:'POST',body:'x'.repeat(4097)})).status).toBe(413);
 expect((await fetch(BASE+'/api/suite/userinfo')).status).toBe(401);
});
it('suite identity fails closed during workspace ambiguity and recovers without changing data',async()=>{
 const g=await issue('accounts'),token=await(await redeem(g)).json();
 const identity=await(await userinfo(token.access_token)).json();
 const extra=await db.workspace.create({data:{name:'Synthetic ambiguous suite workspace'}});
 try{
  expect((await userinfo(token.access_token)).status).toBe(503);
  expect((await fetch(BASE+'/api/suite/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_id:'accounts',client_secret:secret('accounts'),user_id:g.who.id,source_session_id:identity.source_session_id})})).status).toBe(503);
 }finally{await db.workspace.delete({where:{id:extra.id}});}
 expect((await userinfo(token.access_token)).status).toBe(200);
});
it('expired bearer tokens cannot retrieve identity',async()=>{
 const g=await issue('accounts'),token=await(await redeem(g)).json();
 await db.suiteGrant.updateMany({where:{userId:g.who.id},data:{accessExpiresAt:new Date(0)}});
 expect((await userinfo(token.access_token)).status).toBe(401);
});
