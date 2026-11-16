import { expect,it } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
const require=createRequire(import.meta.url);
const { Client }=require('pg');
const { restoreConnectionOptions }=require('../deploy/restore-connection.cjs');
it('preserves supplied verify-full, CA and hostname policy',()=>{
 const url='postgresql://synthetic:unused@localhost:5432/unused?sslmode=verify-full';
 const c=new Client(restoreConnectionOptions(url));
 expect(c.connectionParameters.ssl).not.toBe(false);
 expect(c.connectionParameters.ssl.rejectUnauthorized).not.toBe(false);
 expect(c.connectionParameters.ssl.checkServerIdentity).toBeUndefined();
 expect(restoreConnectionOptions(url).connectionString).toBe(url);
});
it('verify-full rejects a real untrusted TLS certificate',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'sho-tls-'));
 let server:tls.Server|undefined;
 try{
  const key=path.join(dir,'key.pem'),cert=path.join(dir,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-subj','/CN=localhost','-days','1'],{stdio:'ignore'});
  server=tls.createServer({key:readFileSync(key),cert:readFileSync(cert)},s=>s.end());
  server.on('tlsClientError',()=>{});
  await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(0,'127.0.0.1',resolve);});
  const port=(server.address() as {port:number}).port;
  const config=new Client(restoreConnectionOptions('postgresql://synthetic:unused@localhost/unused?sslmode=verify-full')).connectionParameters.ssl;
  const outcome=await new Promise<string>((resolve)=>{
   const socket=tls.connect({...config,host:'127.0.0.1',servername:'localhost',port});
   socket.once('secureConnect',()=>{socket.destroy();resolve('unexpectedly-trusted');});
   socket.once('error',(err:NodeJS.ErrnoException)=>{socket.destroy();resolve(err.code??'error');});
   socket.setTimeout(3000,()=>{socket.destroy();resolve('timeout');});
  });
  expect(['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN']).toContain(outcome);
 }finally{
  if(server?.listening)await new Promise<void>(r=>server!.close(()=>r()));
  rmSync(dir,{recursive:true,force:true});
 }
});
it('production SSH paths require a preverified pin and strict host checking',()=>{
 for(const file of ['deploy.yml','restore-check.yml']){
  const source=readFileSync('.github/workflows/'+file,'utf8');
  expect(source).not.toContain('ssh-keyscan');expect(source).toContain('[ -n "$HOST_KEY" ]');
  expect(source).toContain('StrictHostKeyChecking=yes');expect(source).toContain('ssh-keygen -F');
 }
});
