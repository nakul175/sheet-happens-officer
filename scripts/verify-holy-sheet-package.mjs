import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const record=JSON.parse(await readFile('vendor/holy-sheet-editor.provenance.json','utf8'));
assert.equal(record.repository,'https://github.com/nakul175/holy-sheet.git');
assert.match(record.sourceCommit,/^[a-f0-9]{40}$/);assert.match(record.filename,/^aplyd-holy-sheet-editor-[a-z0-9.-]+\.tgz$/);
const bytes=await readFile(join('vendor',record.filename));
assert.equal('sha512-'+createHash('sha512').update(bytes).digest('base64'),record.integrity);
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
assert.equal(lock.packages['node_modules/@aplyd/holy-sheet-editor'].integrity,record.integrity);
const installed='node_modules/@aplyd/holy-sheet-editor';
assert.equal(JSON.parse(await readFile(`${installed}/package.json`,'utf8')).version,record.version);
const manifestBytes=await readFile(`${installed}/dist/source-manifest.json`);
assert.equal(createHash('sha256').update(manifestBytes).digest('hex'),record.manifestSha256);
const manifest=JSON.parse(manifestBytes);
let temporary;
try{
  if(process.argv.includes('--source-check')){
    const checkout=process.env.HS_EDITOR_SOURCE_CHECKOUT??(temporary=await mkdtemp(join(tmpdir(),'hs-editor-source-')));
    if(temporary){execFileSync('git',['init','--quiet',checkout]);execFileSync('git',['-C',checkout,'fetch','--quiet','--depth=1',record.repository,record.sourceCommit],{stdio:'pipe'});}
    for(const source of manifest.sources){
      assert.ok(!source.path.startsWith('/')&&!source.path.split('/').some(part=>part==='..'));
      const content=execFileSync('git',['-C',checkout,'show',`${record.sourceCommit}:${source.path}`],{maxBuffer:2_000_000});
      assert.equal(createHash('sha256').update(content).digest('hex'),source.sha256,source.path);
    }
  }
  console.log(`Verified editor ${record.version}: archive integrity, installed manifest and ${manifest.sources.length} pinned source records${process.argv.includes('--source-check')?' against canonical Git source':''}.`);
}finally{if(temporary)await rm(temporary,{recursive:true,force:true});}
