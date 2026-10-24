// SHO-2897: test-owned app and private outbox lifecycle; never changes an existing service.
// The caller/spec creates outbox first; the actual app writer receives precisely that path.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

export async function startOwnedOutboxApp({outbox,mode}: {outbox: string; mode: "all" | "admins" | "off"}) {
 const env=process.env;
 const appRoot=env.SHO_QA_APP_ROOT;
 const expectedRelease=env.SHO_QA_RELEASE;
 assert.ok(appRoot, "SHO_QA_APP_ROOT must name the built app under test");
 assert.ok(expectedRelease, "SHO_QA_RELEASE must name the expected full commit");
 assert.ok(env.DATABASE_URL, "A scoped DATABASE_URL is required for the owned app");
 assert.match(expectedRelease,/^[a-f0-9]{40}$/);
 const root=await realpath(appRoot), mail=await realpath(outbox);
 const permissions=(await stat(mail)).mode&0o777;
 assert.equal(permissions,0o700,'Private outbox must have0700 permissions');
 const database=new URL(env.DATABASE_URL);
 const local=['127.0.0.1','localhost','[::1]'].includes(database.hostname);
 if(!local){
  assert.equal(database.hostname,'private-sho-db-do-user-45345612-0.k.db.ondigitalocean.com');
  assert.equal(database.username,'sho_slot_pr9_app');assert.equal(database.pathname,'/sho_staging');assert.equal(database.searchParams.get('schema'),'sho_pr9');
  assert.equal(root,`/home/shoslot/pr9/releases/${expectedRelease.slice(0,7)}`);
  assert.ok(mail.startsWith('/home/shoslot/pr9/var/'),'Staging outbox must stay in slot9 writable tree');
 }
 const childEnv: NodeJS.ProcessEnv={NODE_ENV:'production',PORT:'0',SHO_BIND_HOST:'127.0.0.1',EMAIL_OUTBOX_DIR:mail,RELEASE:expectedRelease,SHO_DEPLOY_STAGE:'staging',CRM_VISIBLE:mode};
 // Explicit allowlist: no production model/email provider credentials, no broad host environment.
 for(const key of ['PATH','HOME','DATABASE_URL','DIRECT_DATABASE_URL','SUPER_ADMIN_EMAILS','FF_TASK_COMMENTS','SIGNIN_RETURN_TO','TZ','JOB_SECRET','MODEL_PROVIDER','MODEL_NAME','MODEL_DATA_APPROVED','ANTHROPIC_API_KEY_STAGE']){
  if(env[key]!==undefined)childEnv[key]=env[key];
 }
 const child=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,env:childEnv,stdio:['ignore','pipe','ignore']});
 const stopped=once(child,'exit');
 let ended=false;child.once('exit',()=>{ended=true;});
 const stop=async()=>{
  if(!ended)child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try{await Promise.race([stopped,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned app did not stop within35seconds')),35000);})]);}
  finally{clearTimeout(timer);if(!ended){child.kill('SIGKILL');await stopped;}}
 };
 try{
  const base=await new Promise<string>((resolve,reject)=>{
   let pending='';const timer=setTimeout(()=>reject(new Error('Owned app startup timed out')),60000);
   child.once('error',()=>{clearTimeout(timer);reject(new Error('Owned app could not start'));});
   child.once('exit',()=>{clearTimeout(timer);reject(new Error('Owned app exited before readiness'));});
   child.stdout.on('data',chunk=>{
    pending=(pending+chunk.toString()).slice(-4096);
    const match=pending.match(/(?:^|\n)sho ready (\d+)\n/);
    if(match){clearTimeout(timer);resolve(`http://127.0.0.1:${match[1]}`);}
   });
  });
  const response=await fetch(base+'/api/health',{signal:AbortSignal.timeout(10000)});
  assert.equal(response.status,200);assert.equal((await response.json()).release,expectedRelease);
  return {base,outbox:mail,stop};
 }catch(error){await stop();throw error;}
}
