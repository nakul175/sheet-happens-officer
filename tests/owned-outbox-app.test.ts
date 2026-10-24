import {test} from 'vitest';
import assert from 'node:assert/strict';
import {writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {startOwnedOutboxApp} from './e2e/owned-outbox-app';
test('actual child writer uses private directory; production credentials are absent; process stops',async()=>{
 const root=mkdtempSync(path.join(tmpdir(),'sho2897-runner-'));
 const outbox=path.join(root,'private-mail');await mkdir(outbox,{mode:0o700});
 const sha='0123456789012345678901234567890123456789';let app: Awaited<ReturnType<typeof startOwnedOutboxApp>> | undefined;
 const keys=['SHO_QA_APP_ROOT','SHO_QA_RELEASE','DATABASE_URL','ANTHROPIC_API_KEY','RESEND_API_KEY'];
 const saved=new Map(keys.map(k=>[k,process.env[k]]));
 try{
  await writeFile(path.join(root,'server.js'),`const http=require('http'),fs=require('fs');
  if(process.env.ANTHROPIC_API_KEY||process.env.RESEND_API_KEY)process.exit(8);
  fs.writeFileSync(process.env.EMAIL_OUTBOX_DIR+'/writer-proof','owned-mail');
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({release:process.env.RELEASE}));});
  server.listen(0,'127.0.0.1',()=>console.log('sho ready '+server.address().port));
  process.on('SIGTERM',()=>server.close(()=>process.exit(0)));`);
  Object.assign(process.env,{SHO_QA_APP_ROOT:root,SHO_QA_RELEASE:sha,DATABASE_URL:'postgresql://fixture:fixture@127.0.0.1:55432/test',ANTHROPIC_API_KEY:'must-not-pass',RESEND_API_KEY:'must-not-pass'});
  app=await startOwnedOutboxApp({outbox,mode:'all'});
  assert.equal(await readFile(path.join(outbox,'writer-proof'),'utf8'),'owned-mail');
  await app.stop();
  await assert.rejects(fetch(app.base+'/api/health',{signal:AbortSignal.timeout(1000)}));
 }finally{if(app)await app.stop();await rm(root,{recursive:true,force:true});for(const [k,v] of saved){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
