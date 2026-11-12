import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const sha='a'.repeat(40);
function run(kind){
 const root=mkdtempSync(path.join(tmpdir(),'sho-reserve-'));
 try{
  mkdirSync(path.join(root,'releases'));const target=path.join(root,'releases',sha);
  if(kind==='existing'){mkdirSync(target);writeFileSync(path.join(target,'sentinel'),'keep');}
  if(kind==='symlink')symlinkSync(path.join(root,'missing'),target);
  const script=readFileSync('deploy/reserve-release.sh','utf8').replace('ROOT=/opt/sho',`ROOT='${root}'`);
  const result=spawnSync('bash',['-s','--',kind==='invalid'?'../../current':sha],{input:script,encoding:'utf8'});
  if(kind==='existing')assert.equal(readFileSync(path.join(target,'sentinel'),'utf8'),'keep');
  if(kind==='new')assert.ok(existsSync(target));
  return result;
 }finally{rmSync(root,{recursive:true,force:true});}
}
test('reserves a new release before upload',()=>assert.equal(run('new').status,0));
for(const kind of ['existing','symlink','invalid'])test(`refuses ${kind} release destination before any overwrite`,()=>assert.notEqual(run(kind).status,0));
test('workflow reserves before rsync rather than relying on a post-upload guard',()=>{
 const s=readFileSync('.github/workflows/deploy.yml','utf8');
 assert.ok(s.indexOf('deploy/reserve-release.sh')<s.indexOf('rsync -az'));
 assert.ok(s.includes('deploy/reserve-release.sh'));
});
