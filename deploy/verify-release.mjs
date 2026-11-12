import { readFile,realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const sha256=b=>createHash('sha256').update(b).digest('hex');
function check(ok,code){if(!ok)throw new Error(code);}
export async function verifyRelease({root,expected,origin,pid,procRoot='/proc'}){
 check(/^[0-9a-f]{40}$/.test(expected),'INVALID_SHA');
 const url=new URL(origin);check(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password,'INVALID_ORIGIN');
 const request=async(p,options={})=>fetch(new URL(p,url),{redirect:'manual',signal:AbortSignal.timeout(5000),...options});
 check((await readFile(path.join(root,'COMMIT'),'utf8')).trim()===expected,'COMMIT_MISMATCH');
 check(/^\d+$/.test(String(pid))&&Number(pid)>0,'INVALID_PID');
 check(await realpath(path.join(procRoot,String(pid),'cwd'))===await realpath(root),'PROCESS_CWD_MISMATCH');
 const buildId=(await readFile(path.join(root,'.next/BUILD_ID'),'utf8')).trim();check(!!buildId,'BUILD_ID_MISSING');
 const manifest=JSON.parse(await readFile(path.join(root,'.next/server/app-paths-manifest.json'),'utf8'));
 for(const route of ['authorize','token','userinfo','status'])check(!!manifest[`/api/suite/${route}/route`],`SUITE_${route.toUpperCase()}_MISSING`);
 const health=await request('/api/health');check(health.status===200,'HEALTH_STATUS');const h=await health.json();check(h.ok===true&&h.release===expected,'HEALTH_IDENTITY');
 for(const client of ['accounts','bugoff']){
  const callback=client==='accounts'?'https://accounts.aplyd.org/bridge/callback':'https://bugoff.aplyd.org/api/auth/callback/aplyd';
  const q=new URLSearchParams({client_id:client,redirect_uri:callback,response_type:'code',code_challenge_method:'S256',code_challenge:'c'.repeat(43),state:'s'.repeat(32)});
  const auth=await request('/api/suite/authorize?'+q);check(auth.status===302,'AUTHORIZE_STATUS');
  const location=new URL(auth.headers.get('location')??'',url);check(location.origin==='https://sheethappensofficer.aplyd.org'&&location.pathname==='/signin','AUTHORIZE_REDIRECT');
 }
 check((await request('/api/suite/userinfo')).status===401,'USERINFO_STATUS');
 check((await request('/api/suite/token',{method:'POST',body:new URLSearchParams({client_id:'accounts',client_secret:'invalid-audit-secret'})})).status===401,'TOKEN_STATUS');
 check((await request('/api/suite/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({client_id:'accounts',client_secret:'invalid-audit-secret'})})).status===401,'STATUS_STATUS');
 const signin=await request('/signin');check(signin.status===200,'SIGNIN_STATUS');
 const html=await signin.text();const assets=[...new Set([...html.matchAll(/(?:src|href)="([^" ]+)"/g)].map(m=>m[1].split('?')[0]).filter(x=>x.startsWith('/_next/static/')&&/\.(?:js|css)$/.test(x)))];
 check(assets.some(x=>x.endsWith('.js'))&&assets.some(x=>x.endsWith('.css')),'ASSETS_MISSING');
 for(const asset of assets){
  const file=path.resolve(root,'.next',asset.slice('/_next/'.length));check(file.startsWith(path.resolve(root,'.next/static')+path.sep),'ASSET_PATH');
  const remote=await request(asset);check(remote.status===200,'ASSET_STATUS');
  check(sha256(Buffer.from(await remote.arrayBuffer()))===sha256(await readFile(file)),'ASSET_MISMATCH');
 }
 return {sha:expected,buildId,assets:assets.length,suiteRoutes:4,processVerified:true};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const [root,expected,origin,pid]=process.argv.slice(2);
 verifyRelease({root,expected,origin,pid}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error('RELEASE_VERIFY_FAILED',/^[A-Z_]+$/.test(e.message)?e.message:'CHECK_FAILED');process.exitCode=1});
}
