// Real local HTTP/DB suite flow; redirects are inspected, never followed off-host.
import { afterAll,beforeAll,expect,it } from 'vitest';
import { createHash,randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
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
 const [grants,users]=await Promise.all([
  db.suiteGrant.count({where:{userId:{in:ids}}}),
  db.user.count({where:{id:{in:ids}}}),
 ]);
 expect({grants,users}).toEqual({grants:0,users:0});
 if(ids.length){mkdirSync('test-results/suite-code-race',{recursive:true});writeFileSync('test-results/suite-code-race/cleanup.json',JSON.stringify({ownedUsersRemoved:ids.length,ownedGrantsRemaining:0,ownedUsersRemaining:0,disposableCiDatabase:true},null,2));}
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
it('preserves all four suite routes and denies unauthenticated requests without leaking redirects',async()=>{
 const verifier=randomBytes(32).toString('base64url');
 const params=new URLSearchParams({client_id:'accounts',redirect_uri:callback('accounts'),response_type:'code',code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),state:randomBytes(24).toString('base64url')});
 const signedOut=await fetch(BASE+'/api/suite/authorize?'+params,{redirect:'manual'});
 expect(signedOut.status).toBe(302);
 const signin=new URL(signedOut.headers.get('location')!);
 expect(signin.origin+signin.pathname).toBe('https://sheethappensofficer.aplyd.org/signin');
 expect(signin.searchParams.get('returnTo')).toContain('client_id=accounts');
 const denied=[
  await fetch(BASE+'/api/suite/authorize?client_id=unknown-client',{redirect:'manual'}),
  await fetch(BASE+'/api/suite/token',{method:'POST',body:new URLSearchParams({client_id:'accounts',client_secret:'invalid'})}),
  await fetch(BASE+'/api/suite/userinfo'),
  await fetch(BASE+'/api/suite/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_id:'accounts',client_secret:'invalid'})}),
 ];
 expect(denied.map(response=>response.status)).toEqual([400,401,401,401]);
 for(const response of [signedOut,...denied]){
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
 }
 for(const response of denied)expect(response.headers.get('location')).toBeNull();
 mkdirSync('test-results/suite-route-preservation',{recursive:true});
 writeFileSync('test-results/suite-route-preservation/verification.json',JSON.stringify({routes:['authorize','token','userinfo','status'],signedOutAuthorize302:true,denialStatuses:[400,401,401,401],unauthorizedRedirects:0,noStoreAndNoReferrer:true,privateRuntime:true},null,2));
});
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
it('authorize rejects attacker callbacks, clients, state and PKCE method without creating a grant',async()=>{
 const who=await account('zzsuiteattack');accounts.push(who);
 const verifier=randomBytes(32).toString('base64url');
 const valid=new URLSearchParams({client_id:'accounts',redirect_uri:callback('accounts'),response_type:'code',code_challenge_method:'S256',code_challenge:createHash('sha256').update(verifier).digest('base64url'),state:randomBytes(24).toString('base64url')});
 const attacks:[string,string][]=[
  ['redirect_uri','https://accounts.aplyd.org/bridge/callback.evil.invalid'],
  ['redirect_uri','https://evil.invalid/bridge/callback'],
  ['client_id','unknown-client'],
  ['client_id','bugoff'],
  ['state','short'],
  ['code_challenge_method','plain'],
  ['code_challenge','bad'],
 ];
 for(const [key,value] of attacks){
  const p=new URLSearchParams(valid);p.set(key,value);
  const response=await fetch(BASE+'/api/suite/authorize?'+p,{headers:{cookie:who.c.cookie},redirect:'manual'});
  expect(response.status,`${key}=${value}`).toBe(400);
  expect(response.headers.get('location')).toBeNull();
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toEqual({error:'invalid_request'});
 }
 expect(await db.suiteGrant.count({where:{userId:who.id}})).toBe(0);
 mkdirSync('test-results/suite-authorize-attacks',{recursive:true});
 writeFileSync('test-results/suite-authorize-attacks/verification.json',JSON.stringify({rejectedInputs:attacks.length,redirectsIssued:0,storedGrants:0},null,2));
});
it('a valid Accounts code cannot be redeemed by BugOff and remains valid for Accounts',async()=>{
 const g=await issue('accounts');
 const denied=await redeem(g,{client_id:'bugoff',client_secret:secret('bugoff'),redirect_uri:callback('bugoff')});
 expect(denied.status).toBe(400);
 expect(await denied.json()).toEqual({error:'invalid_grant'});
 const stored=await db.suiteGrant.findUnique({where:{codeHash:createHash('sha256').update(g.code).digest('hex')}});
 expect(stored).toMatchObject({clientId:'accounts',redeemedAt:null,accessTokenHash:null});
 expect((await redeem(g)).status).toBe(200);
 mkdirSync('test-results/suite-authorize-attacks',{recursive:true});
 writeFileSync('test-results/suite-authorize-attacks/client-binding.json',JSON.stringify({wrongClientDenied:true,codeUnspentAfterDenial:true,rightClientRedeemed:true},null,2));
});
it('concurrent code redemption has one stored winner per suite client and denies replay',async()=>{
 for(const client of ['accounts','bugoff']){
  const g=await issue(client),responses=await Promise.all(Array.from({length:4},()=>redeem(g)));
  expect(responses.map(r=>r.status).sort()).toEqual([200,400,400,400]);
  const bodies=await Promise.all(responses.map(r=>r.json()));
  expect(bodies.filter(body=>body.error==='invalid_grant')).toHaveLength(3);
  const winner=bodies.find(body=>typeof body.access_token==='string');
  expect(winner?.access_token).toBeTypeOf('string');
  const grants=await db.suiteGrant.findMany({where:{codeHash:createHash('sha256').update(g.code).digest('hex')}});
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({clientId:client,userId:g.who.id,accessTokenHash:createHash('sha256').update(winner!.access_token).digest('hex')});
  expect(grants[0].redeemedAt).not.toBeNull();
  expect((await redeem(g)).status).toBe(400);
  mkdirSync('test-results/suite-code-race',{recursive:true});
  writeFileSync(`test-results/suite-code-race/${client}.json`,JSON.stringify({client,requests:4,issuedTokens:1,invalidGrants:3,storedGrants:1,replayDenied:true},null,2));
 }
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
