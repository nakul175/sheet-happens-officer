import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,symlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyRelease } from '../../deploy/verify-release.mjs';
import { verifyPreviousRelease } from '../../deploy/verify-previous-release.mjs';
const expected='a'.repeat(40);
async function exercise(change='',verify=verifyRelease){
 const dir=await mkdtemp(path.join(tmpdir(),'sho-identity-')),root=path.join(dir,'release'),proc=path.join(dir,'proc');
 const original=globalThis.fetch;
 try{
  await mkdir(path.join(root,'.next/server'),{recursive:true});await mkdir(path.join(root,'.next/static'),{recursive:true});await mkdir(path.join(proc,'123'),{recursive:true});
  await symlink(change==='process'?dir:root,path.join(proc,'123/cwd'));
  await writeFile(path.join(root,'COMMIT'),change==='commit'?'b'.repeat(40):expected);await writeFile(path.join(root,'.next/BUILD_ID'),'synthetic-build');
  const manifest=Object.fromEntries(['authorize','token','userinfo','status'].map(r=>[`/api/suite/${r}/route`,r]));if(change==='manifest')delete manifest['/api/suite/status/route'];
  await writeFile(path.join(root,'.next/server/app-paths-manifest.json'),JSON.stringify(manifest));
  for(const ext of ['js','css'])await writeFile(path.join(root,'.next/static/app.'+ext),'synthetic-'+ext);
  globalThis.fetch=async(raw)=>{
   const u=new URL(raw),p=u.pathname;
   if(p==='/api/health')return Response.json({ok:true,release:change==='health'?'wrong':expected});
   if(p==='/api/suite/authorize')return new Response(null,{status:302,headers:{location:change==='redirect'?'https://evil.invalid/signin':'https://sheethappensofficer.aplyd.org/signin'}});
   if(p.startsWith('/api/suite/'))return new Response(null,{status:change==='suite401'?404:401});
   if(p==='/signin')return new Response(change==='assets'?'': '<script src="/_next/static/app.js"></script><link href="/_next/static/app.css">');
   if(p.startsWith('/_next/static/'))return new Response(change==='asset404'?'':change==='assetHash'?'wrong':'synthetic-'+p.split('.').pop(),{status:change==='asset404'?404:200});
   throw Error('unexpected test request '+p);
  };
  return await verify({root,expected,origin:'http://127.0.0.1:3000',pid:'123',procRoot:proc});
 }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
}
test('matching process, source, manifest, public assets and suite checks pass',async()=>{const r=await exercise();assert.equal(r.sha,expected);assert.equal(r.assets,2);assert.equal(r.suiteRoutes,4);});
for(const [change,code] of [['commit','COMMIT_MISMATCH'],['process','PROCESS_CWD_MISMATCH'],['manifest','SUITE_STATUS_MISSING'],['health','HEALTH_IDENTITY'],['redirect','AUTHORIZE_REDIRECT'],['suite401','USERINFO_STATUS'],['assets','ASSETS_MISSING'],['asset404','ASSET_STATUS'],['assetHash','ASSET_MISMATCH']])test(`refuses ${change}`,async()=>assert.rejects(exercise(change),new RegExp(code)));

test('independent previous-release verifier accepts matching baseline identity and assets',async()=>{const r=await exercise('',verifyPreviousRelease);assert.equal(r.sha,expected);assert.equal(r.assets,2);assert.equal(r.suiteRoutes,4);});
for(const [change,code] of [['commit','COMMIT_MISMATCH'],['process','PROCESS_CWD_MISMATCH'],['manifest','SUITE_STATUS_MISSING'],['health','HEALTH_IDENTITY'],['redirect','AUTHORIZE_REDIRECT'],['suite401','USERINFO_STATUS'],['assets','ASSETS_MISSING'],['asset404','ASSET_STATUS'],['assetHash','ASSET_MISMATCH']])test(`previous-release verifier refuses ${change}`,async()=>assert.rejects(exercise(change,verifyPreviousRelease),new RegExp(code)));
