import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const sha='a'.repeat(40);
function run(kind, availableKiB){
 const root=mkdtempSync(path.join(tmpdir(),'sho-reserve-'));
 try{
  mkdirSync(path.join(root,'releases'));const target=path.join(root,'releases',sha);
  const bin=path.join(root,'bin');mkdirSync(bin);
  if(availableKiB!==undefined)writeFileSync(path.join(bin,'df'),`#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/test 10000000 0 ${availableKiB} 0%% /\\n'\n`,{mode:0o755});
  if(kind==='existing'){mkdirSync(target);writeFileSync(path.join(target,'sentinel'),'keep');}
  if(kind==='symlink')symlinkSync(path.join(root,'missing'),target);
  const script=readFileSync('deploy/reserve-release.sh','utf8').replace('ROOT=/opt/sho',`ROOT='${root}'`);
  const result=spawnSync('bash',['-s','--',kind==='invalid'?'../../current':sha],{input:script,encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`}});
  if(kind==='existing')assert.equal(readFileSync(path.join(target,'sentinel'),'utf8'),'keep');
  if(kind==='new'||kind==='boundary')assert.ok(existsSync(target));
  if(kind==='low')assert.equal(existsSync(target),false);
  return result;
 }finally{rmSync(root,{recursive:true,force:true});}
}
test('reserves a new release before upload',()=>assert.equal(run('new').status,0));
test('reserves at the measured 6 GiB headroom boundary',()=>assert.equal(run('boundary',6291456).status,0));
test('refuses one KiB below the headroom boundary before creating a release directory',()=>{
 const result=run('low',6291455);assert.notEqual(result.status,0);assert.match(result.stdout,/INSUFFICIENT_RELEASE_SPACE/);
});
for(const kind of ['existing','symlink','invalid'])test(`refuses ${kind} release destination before any overwrite`,()=>assert.notEqual(run(kind).status,0));
test('workflow reserves before rsync rather than relying on a post-upload guard',()=>{
 const s=readFileSync('.github/workflows/deploy.yml','utf8');
 assert.ok(s.indexOf('deploy/reserve-release.sh')<s.indexOf('rsync -az'));
 assert.ok(s.includes('deploy/reserve-release.sh'));
});
