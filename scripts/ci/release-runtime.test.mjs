import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,realpathSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const sha='a'.repeat(40);
function exercise(failure='') {
 const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'sho-release-test-')));
 try {
  const root=path.join(dir,'sho'),bin=path.join(dir,'bin'),rel=path.join(root,'releases',sha),prev=path.join(root,'releases','b'.repeat(40));
  mkdirSync(rel,{recursive:true});mkdirSync(prev,{recursive:true});mkdirSync(bin);symlinkSync(prev,path.join(root,'current'));
  writeFileSync(path.join(dir,'app.env'),'DATABASE_URL=postgresql://synthetic@127.0.0.1:1/unused\n');
  const dispatcher=`#!${process.execPath}\nconst fs=require('fs'),path=require('path');const cmd=path.basename(process.argv[1]),args=process.argv.slice(2);fs.appendFileSync(process.env.CALL_LOG,JSON.stringify({cmd,args})+'\\n');if(cmd==='mv'){const a=args.filter(x=>x!=='-T');fs.renameSync(a[0],a[1]);}if(cmd==='npx'&&args.includes('status')&&process.env.FAILURE==='migration')process.exit(7);if(cmd==='npx'&&args.includes('build')&&process.env.FAILURE==='build')process.exit(8);if(cmd==='flock'&&process.env.FAILURE==='lock')process.exit(1);if(cmd==='sudo'&&(process.env.FAILURE==='rollback'||(process.env.FAILURE==='restart'&&fs.readFileSync(process.env.CALL_LOG,'utf8').split('\"cmd\":\"sudo\"').length===2)))process.exit(9);if(cmd==='curl')console.log(JSON.stringify({ok:true,release:'${sha}'}));`;
  for(const cmd of ['npm','npx','sudo','curl','sleep','find','mv','crontab','install','flock']){writeFileSync(path.join(bin,cmd),dispatcher,{mode:0o755});}
  let source=readFileSync(new URL('../../deploy/release.sh',import.meta.url),'utf8');
  source=source.replace('ROOT=/opt/sho',`ROOT="${root}"`).replaceAll('/etc/sho/app.env',path.join(dir,'app.env')).replaceAll('/etc/sho/local.env',path.join(dir,'absent.env'));
  const script=path.join(dir,'release.sh');writeFileSync(script,source);
  const log=path.join(dir,'calls.jsonl');writeFileSync(log,'');
  const result=spawnSync('bash',[script,failure==='revision'?'bad; touch unexpected':sha],{env:{...process.env,PATH:bin+':'+process.env.PATH,CALL_LOG:log,FAILURE:failure},encoding:'utf8',timeout:10000});
  const calls=readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return {status:result.status,error:result.error,output:result.stdout+result.stderr,calls,current:realpathSync(path.join(root,'current')),previous:realpathSync(prev),candidate:realpathSync(rel)};
 } finally {rmSync(dir,{recursive:true,force:true});}
}
test('pending migration fails before build/switch without attempting DDL',()=>{
 const r=exercise('migration');assert.equal(r.status,7,r.output);assert.equal(r.current,r.previous);
 assert.deepEqual(r.calls.filter(c=>c.cmd==='npx').map(c=>c.args),[['--no-install','prisma','migrate','status']]);
 assert.equal(r.calls.some(c=>['sudo','crontab','install'].includes(c.cmd)),false);
});
test('successful app cut invokes no migration apply or scheduler commands',()=>{
 const r=exercise();assert.equal(r.status,0,r.output);assert.equal(r.current,r.candidate);
 assert.equal(r.calls.some(c=>['crontab','install'].includes(c.cmd)),false);
 assert.equal(r.calls.some(c=>c.cmd==='npx'&&c.args.includes('deploy')),false);
});
test('invalid revision executes no install/build/service commands',()=>{
 const r=exercise('revision');assert.equal(r.status,1,r.output);assert.equal(r.calls.length,0);assert.equal(r.current,r.previous);
});

test('restart failure restores previous pointer and restarts it',()=>{
 const r=exercise('restart');assert.equal(r.status,9,r.output);assert.equal(r.current,r.previous);
 assert.equal(r.calls.filter(c=>c.cmd==='sudo').length,2);assert.match(r.output,/rollback verified/);
});
test('failed rollback is explicit, never reported as release success',()=>{
 const r=exercise('rollback');assert.equal(r.status,9,r.output);assert.equal(r.current,r.previous);
 assert.match(r.output,/RECOVERY_FAILED/);assert.doesNotMatch(r.output,/is live/);
});
test('pre-switch build failure preserves baseline and does not restart',()=>{
 const r=exercise('build');assert.equal(r.status,8,r.output);assert.equal(r.current,r.previous);assert.equal(r.calls.some(c=>c.cmd==='sudo'),false);
});
test('busy deployment lock refuses install and switch',()=>{
 const r=exercise('lock');assert.equal(r.status,1,r.output);assert.equal(r.current,r.previous);assert.deepEqual(r.calls.map(c=>c.cmd),['flock']);
});
