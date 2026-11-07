// Bounded synthetic baseline, not a production load test or an SLA assertion.
import { expect,it } from 'vitest';
import { randomUUID,createHash,randomBytes } from 'node:crypto';
import { mkdirSync,writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { db } from '@/lib/db';

it('records local API latency for 100 projects / 10,000 tasks and cleans its exact fixture',async()=>{
 const database=new URL(process.env.DATABASE_URL??''),base=new URL(process.env.TASKBOARD_URL??'');
 if(![database,base].every(u=>['localhost','127.0.0.1'].includes(u.hostname))||database.pathname!='/sho_test')throw Error('DISPOSABLE_LOOPBACK_FIXTURE_REQUIRED');
 const id='perf-'+randomUUID(),projectIds:string[]=[];
 const raw=randomBytes(32).toString('base64url');
 const report:{fixture:unknown;environment:unknown;measurements:unknown[];cleanup:boolean;status:string}={fixture:{projects:100,tasks:10000,users:1},environment:{node:process.version,platform:process.platform,architecture:process.arch},measurements:[],cleanup:false,status:'INCOMPLETE'};
 let created=false;
 const originalProjects=await db.project.count(),originalUsers=await db.user.count();
 const read=async(route:string)=>{
  const start=performance.now();
  const response=await fetch(new URL(route,base),{headers:{cookie:'sho_session='+raw},signal:AbortSignal.timeout(20000)});
  const body=await response.arrayBuffer();
  expect(response.status,route).toBe(200);
  return{ms:performance.now()-start,bytes:body.byteLength};
 };
 try{
  const workspaces=await db.workspace.findMany({take:2});expect(workspaces).toHaveLength(1);
  await db.user.create({data:{id,workspaceId:workspaces[0].id,name:'Synthetic performance',email:id+'@example.invalid',passwordHash:'not-a-login',emailVerifiedAt:new Date()}});created=true;
  await db.session.create({data:{userId:id,tokenHash:createHash('sha256').update(raw).digest('hex'),expiresAt:new Date(Date.now()+3600000)}});
  for(let n=0;n<100;n++){
   const p=await db.project.create({data:{workspaceId:workspaces[0].id,name:`${id} project ${n}`,members:{create:{userId:id,role:'LEADER'}},sections:{create:[{name:'To do',position:0},{name:'In progress',position:1},{name:'Done',position:2,isDone:true}]}},include:{sections:true}});projectIds.push(p.id);
   await db.task.createMany({data:Array.from({length:100},(_,t)=>({workspaceId:workspaces[0].id,projectId:p.id,sectionId:p.sections.find(s=>s.name==='To do')!.id,title:`${id} task ${n}-${t}`,assigneeId:id,createdById:id,dueDate:new Date()}))});
  }
  expect(await db.task.count({where:{projectId:{in:projectIds}}})).toBe(10000);
  for(const route of ['/api/projects','/api/my-tasks','/api/search?q='+id,'/api/projects/'+projectIds[0]]){
   const first=await read(route),samples:Awaited<ReturnType<typeof read>>[]=[];
   for(let batch=0;batch<2;batch++)samples.push(...await Promise.all(Array.from({length:5},()=>read(route))));
   const sorted=samples.map(x=>x.ms).sort((a,b)=>a-b);
   report.measurements.push({route:route.startsWith('/api/search')?'/api/search?q=<fixture>':route.startsWith('/api/projects/')?'/api/projects/<fixture>':route,concurrency:5,samples:sorted.length,firstRequestMs:Math.round(first.ms),p50Ms:Math.round(sorted[4]),p95Ms:Math.round(sorted[9]),maxBytes:Math.max(...samples.map(x=>x.bytes))});
  }
  report.status='MEASURED_NO_SLA_SET';
 }finally{
  try{
   if(created){await db.task.deleteMany({where:{projectId:{in:projectIds}}});await db.project.deleteMany({where:{id:{in:projectIds}}});await db.user.delete({where:{id}});}
   expect(await db.project.count({where:{id:{in:projectIds}}})).toBe(0);
   expect(await db.task.count({where:{projectId:{in:projectIds}}})).toBe(0);
   expect(await db.project.count()).toBe(originalProjects);
   expect(await db.user.count()).toBe(originalUsers);
   report.cleanup=true;
  }finally{
   mkdirSync('test-results/performance',{recursive:true});writeFileSync('test-results/performance/baseline.json',JSON.stringify(report,null,2)+'\n');
  }
 }
},180000);
