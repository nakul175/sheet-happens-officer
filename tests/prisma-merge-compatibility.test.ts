import { expect,it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfigFromFile } from '@prisma/config';
const require=createRequire(import.meta.url);
const prismaRequire=createRequire(require.resolve('@prisma/config'));
const { deepmerge }=prismaRequire('deepmerge-ts');
it('the scoped Prisma merger preserves nested config, arrays and explicit values',()=>{
 expect(deepmerge({paths:{schema:'old',migrations:'db'},flags:['one'],enabled:true},{paths:{schema:'new'},flags:['two'],enabled:false})).toEqual({paths:{schema:'new',migrations:'db'},flags:['one','two'],enabled:false});
});
it('recursive object graphs do not exhaust the stack',()=>{
 const a:{value:number;self?:unknown}={value:1};a.self=a;
 const b:{value:number;self?:unknown}={value:2};b.self=b;
 const result=deepmerge(a,b);expect(result.value).toBe(2);expect(result.self).toBe(result);
});
it('Prisma loads real JS configuration using the patched merger without DB access',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'sho-prisma-config-'));
 try{
  const file=path.join(dir,'prisma.config.mjs');
  writeFileSync(file,'export default { schema: "schema.prisma", migrations: { path: "migrations" } };\n');
  const loaded=await loadConfigFromFile({configFile:file,configRoot:dir});
  expect(loaded.error).toBeUndefined();expect(loaded.config?.schema).toBe(path.join(dir,'schema.prisma'));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
