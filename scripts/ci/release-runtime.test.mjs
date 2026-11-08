import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,realpathSync,rmSync,unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const sha='a'.repeat(40);
function exercise(failure='') {
 const dir=realpathSync(mkdtempSync(path.join(tmpdir(),'sho-release-test-')));
 try {
  const root=path.join(dir,'sho'),bin=path.join(dir,'bin'),rel=path.join(root,'releases',sha),prev=path.join(root,'releases',failure==='legacy-previous'?'e1-2642-'+'b'.repeat(40):'b'.repeat(40));
  mkdirSync(rel,{recursive:true});mkdirSync(prev,{recursive:true});mkdirSync(bin);symlinkSync(prev,path.join(root,'current'));
  writeFileSync(path.join(prev,'COMMIT'),'b'.repeat(40));
  if(failure==='candidate-symlink'){rmSync(rel,{recursive:true});symlinkSync(prev,rel);}
  if(failure==='previous-outside'){
   const outside=path.join(dir,'outside-release');mkdirSync(outside);writeFileSync(path.join(outside,'COMMIT'),'b'.repeat(40));
   unlinkSync(path.join(root,'current'));symlinkSync(outside,path.join(root,'current'));
  }
  if(failure==='previous-mismatch')writeFileSync(path.join(prev,'COMMIT'),'c'.repeat(40));
  writeFileSync(path.join(dir,'app.env'),'DATABASE_URL=postgresql://synthetic@127.0.0.1:1/unused\nDIRECT_DATABASE_URL=postgresql://synthetic-admin@127.0.0.1:1/unused\nUNKNOWN_SENTINEL=preserve-me\n');
  const dispatcher=`#!${process.execPath}\nconst fs=require('fs'),path=require('path');const cmd=path.basename(process.argv[1]),args=process.argv.slice(2);fs.appendFileSync(process.env.CALL_LOG,JSON.stringify({cmd,args})+'\\n');if(cmd==='mv'){const a=args.filter(x=>x!=='-T');fs.renameSync(a[0],a[1]);}if(cmd==='npx'&&args.includes('status')&&process.env.FAILURE==='migration')process.exit(7);if(cmd==='npx'&&args.includes('build')&&process.env.FAILURE==='build')process.exit(8);if(cmd==='flock'&&process.env.FAILURE==='lock')process.exit(1);if(cmd==='sudo'&&(process.env.FAILURE==='rollback'||(process.env.FAILURE==='restart'&&fs.readFileSync(process.env.CALL_LOG,'utf8').split('\"cmd\":\"sudo\"').length===2)))process.exit(9);if(cmd==='systemctl')console.log('123');if(cmd==='node'&&process.env.FAILURE==='verify'&&args[2]==='${sha}')process.exit(10);if(cmd==='node'&&process.env.FAILURE==='prune'&&args[0]?.endsWith('/prune-releases.mjs'))process.exit(11);if(cmd==='curl')console.log(JSON.stringify({ok:true,release:'${sha}'}));`;
  for(const cmd of ['npm','npx','sudo','curl','sleep','find','mv','crontab','install','flock','node','systemctl']){writeFileSync(path.join(bin,cmd),dispatcher,{mode:0o755});}
  let source=readFileSync(new URL('../../deploy/release.sh',import.meta.url),'utf8');
  source=source.replace('ROOT=/opt/sho',`ROOT="${root}"`).replaceAll('/etc/sho/app.env',path.join(dir,'app.env')).replaceAll('/etc/sho/local.env',path.join(dir,'absent.env'));
  const script=path.join(dir,'release.sh');writeFileSync(script,source);
  const log=path.join(dir,'calls.jsonl');writeFileSync(log,'');
  // The verify-failure path deliberately waits for health before rollback; ten seconds
  // can expire before the script returns on a loaded CI runner.
  const result=spawnSync('bash',[script,failure==='revision'?'bad; touch unexpected':sha],{env:{...process.env,PATH:bin+':'+process.env.PATH,CALL_LOG:log,FAILURE:failure},encoding:'utf8',timeout:30000});
  const calls=readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return {config:readFileSync(path.join(dir,'app.env'),'utf8'),status:result.status,error:result.error,output:result.stdout+result.stderr,calls,current:realpathSync(path.join(root,'current')),previous:realpathSync(prev),candidate:realpathSync(rel),previousCommit:readFileSync(path.join(prev,'COMMIT'),'utf8')};
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
test('existing e1-story-full-SHA release is accepted as the verified rollback target',()=>{
 const r=exercise('legacy-previous');assert.equal(r.status,0,r.output);assert.equal(r.current,r.candidate);
 assert.equal(r.previousCommit,'b'.repeat(40));
});
test('retention failure is reported without rolling back a verified healthy release',()=>{
 const r=exercise('prune');assert.equal(r.status,0,r.output);assert.equal(r.current,r.candidate);
 assert.match(r.output,/retention deferred/);assert.equal(r.calls.filter(c=>c.cmd==='sudo').length,1);
});

test('invalid revision executes no install/build/service commands',()=>{
 const r=exercise('revision');assert.equal(r.status,1,r.output);assert.equal(r.calls.length,0);assert.equal(r.current,r.previous);
});

for(const failure of ['candidate-symlink','previous-outside','previous-mismatch']){
 test(`${failure} refuses build and service changes before switch`,()=>{
  const r=exercise(failure);assert.equal(r.status,1,r.output);
  assert.equal(r.calls.some(c=>['npm','npx','sudo','mv'].includes(c.cmd)),false,r.output);
  assert.equal(r.previousCommit,failure==='previous-mismatch'?'c'.repeat(40):'b'.repeat(40));
 });
}

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

test('failed post-switch verification restores baseline',()=>{
 const r=exercise('verify');assert.equal(r.status,1,r.output);assert.equal(r.current,r.previous);assert.match(r.output,/rollback verified/);
});

test('app-only cut preserves unknown settings and runtime/admin identities',()=>{
 for(const failure of ['', 'restart', 'migration']){
  const r=exercise(failure);
  assert.equal(r.config,'DATABASE_URL=postgresql://synthetic@127.0.0.1:1/unused\nDIRECT_DATABASE_URL=postgresql://synthetic-admin@127.0.0.1:1/unused\nUNKNOWN_SENTINEL=preserve-me\n');
 }
});
