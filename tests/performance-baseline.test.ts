// Disposable synthetic acceptance fixture; never a production load test or live SLA claim.
import { expect,it } from 'vitest';
import { randomUUID,createHash,randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync,mkdirSync,readFileSync,writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { db } from '@/lib/db';

type ServerResource = { cpuTicks: number; rssKiB: number; highWaterKiB: number };
type CpuProfile = { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples?: number[] };
async function profileLegacyReads(pid: number, read: () => Promise<unknown>) {
 if(process.platform!=='linux')throw Error('AUDIT_CPU_PROFILE_REQUIRES_LINUX');
 // Node enables its inspector on loopback when signalled; this disposable CI
 // process is never a shared staging or production runtime.
 process.kill(pid,'SIGUSR1');
 let debuggerUrl:string|undefined;
 for(let attempt=0;attempt<30;attempt++){
  try{
   const response=await fetch('http://127.0.0.1:9229/json/list',{signal:AbortSignal.timeout(1000)});
   if(response.ok){
    const targets=await response.json() as {webSocketDebuggerUrl?:string}[];
    debuggerUrl=targets[0]?.webSocketDebuggerUrl;
    if(debuggerUrl)break;
   }
  }catch{/* Inspector has not opened yet. */}
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 if(!debuggerUrl||!debuggerUrl.startsWith('ws://127.0.0.1:9229/'))throw Error('AUDIT_LOOPBACK_INSPECTOR_UNAVAILABLE');
 const socket=new WebSocket(debuggerUrl);
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('AUDIT_INSPECTOR_CONNECT_TIMEOUT')),5000);
  socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});
  socket.addEventListener('error',()=>{clearTimeout(timer);reject(Error('AUDIT_INSPECTOR_CONNECT_ERROR'));},{once:true});
 });
 let nextId=0;
 const pending=new Map<number,{resolve:(result:unknown)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 socket.addEventListener('message',(event)=>{
  const message=JSON.parse(String(event.data)) as {id?:number;result?:unknown;error?:{message:string}};
  if(message.id===undefined)return;
  const request=pending.get(message.id);if(!request)return;
  clearTimeout(request.timer);pending.delete(message.id);
  if(message.error)request.reject(Error(`AUDIT_INSPECTOR_${message.error.message}`));else request.resolve(message.result);
 });
 const send=(method:string)=>new Promise<unknown>((resolve,reject)=>{
  const id=++nextId;
  const timer=setTimeout(()=>{pending.delete(id);reject(Error(`AUDIT_INSPECTOR_${method}_TIMEOUT`));},10000);
  pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method}));
 });
 try{
  await send('Profiler.enable');await send('Profiler.start');
  let result:unknown;
  try{await Promise.all(Array.from({length:5},read));}
  finally{result=await send('Profiler.stop');}
  const profile=(result as {profile:CpuProfile}).profile;
  if(!profile?.samples?.length)throw Error('AUDIT_CPU_PROFILE_EMPTY');
  const byId=new Map(profile.nodes.map(node=>[node.id,node.callFrame]));
  const counts=new Map<string,{samples:number;functionName:string;file:string;line:number}>();
  for(const sample of profile.samples){
   const frame=byId.get(sample);if(!frame)continue;
   const file=frame.url.split('/').at(-1)??'';
   const key=`${frame.functionName}|${file}|${frame.lineNumber}`;
   const row=counts.get(key)??{samples:0,functionName:frame.functionName||'(anonymous)',file,line:frame.lineNumber+1};
   row.samples++;counts.set(key,row);
  }
  return{requests:5,sampleCount:profile.samples.length,topFrames:[...counts.values()].sort((a,b)=>b.samples-a.samples).slice(0,25)};
 }finally{socket.close();}
}
function serverResource(): ServerResource | null {
 if(process.platform!=='linux')return null;
 const pidPath='test-results/performance/server.pid';
 if(!existsSync(pidPath)){
  if(process.env.CI)throw Error('AUDIT_SERVER_PID_MISSING');
  return null;
 }
 const pid=Number(readFileSync(pidPath,'utf8').trim());
 if(!Number.isSafeInteger(pid)||pid<=0)throw Error('AUDIT_SERVER_PID_INVALID');
 const command=readFileSync(`/proc/${pid}/cmdline`,'utf8').replaceAll('\0',' ');
 if(!/\bserver\.js\b/.test(command))throw Error('AUDIT_SERVER_PID_NOT_APP');
 const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
 const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
 const status=readFileSync(`/proc/${pid}/status`,'utf8');
 const kb=(label:string)=>Number(status.match(new RegExp(`^${label}:\\s+(\\d+) kB$`,'m'))?.[1]);
 const sample={cpuTicks:Number(fields[11])+Number(fields[12]),rssKiB:kb('VmRSS'),highWaterKiB:kb('VmHWM')};
 if(Object.values(sample).some(value=>!Number.isFinite(value)))throw Error('AUDIT_SERVER_RESOURCE_UNAVAILABLE');
 return sample;
}

it('records local API latency for 10,000 tasks / 1,000 eligible deals and cleans its exact fixture',async()=>{
 const database=new URL(process.env.DATABASE_URL??''),base=new URL(process.env.TASKBOARD_URL??'');
 if(![database,base].every(u=>['localhost','127.0.0.1'].includes(u.hostname))||database.pathname!='/sho_test')throw Error('DISPOSABLE_LOOPBACK_FIXTURE_REQUIRED');
 const clockTicksPerSecond=process.platform==='linux'?Number(execFileSync('getconf',['CLK_TCK'],{encoding:'utf8'}).trim()):null;
 if(clockTicksPerSecond!==null&&(!Number.isFinite(clockTicksPerSecond)||clockTicksPerSecond<=0))throw Error('AUDIT_SERVER_CLOCK_UNAVAILABLE');
 const queryStatsEnabled=process.env.SHO_AUDIT_QUERY_STATS==='1';
 const resetQueryStats=async()=>{await db.$queryRaw`SELECT pg_stat_statements_reset()::text`;};
 const queryStats=async()=>{
  const rows=await db.$queryRaw<{calls:bigint;totalExecMs:number}[]>`SELECT COALESCE(SUM(calls),0)::bigint AS calls, COALESCE(SUM(total_exec_time),0)::double precision AS "totalExecMs" FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query ~* '^[[:space:]]*(SELECT|INSERT|UPDATE|DELETE|MERGE|WITH)[[:space:]]' AND query NOT ILIKE '%pg_stat_statements%'`;
  return {calls:Number(rows[0]?.calls??BigInt(0)),totalExecMs:rows[0]?.totalExecMs??0};
 };
 const id='perf-'+randomUUID(),projectIds:string[]=[],dealIds:string[]=[];
 const raw=randomBytes(32).toString('base64url');
 const report:{fixture:unknown;environment:unknown;measurements:unknown[];legacyCpuProfile?:unknown;dealPaging?:unknown;dealCursorAfterArchive?:boolean;dealList?:unknown;concurrentEdits?:unknown;cleanup:boolean;status:string}={fixture:{projects:100,tasks:10000,eligibleDeals:1000,dealTasksAfterMyTasksMeasurement:10000,users:1},environment:{node:process.version,platform:process.platform,architecture:process.arch,clockTicksPerSecond,queryStatsEnabled},measurements:[],cleanup:false,status:'INCOMPLETE'};
 let created=false;
 const originalProjects=await db.project.count(),originalUsers=await db.user.count();
 const read=async(route:string)=>{
  const start=performance.now();
  const response=await fetch(new URL(route,base),{headers:{cookie:'sho_session='+raw},signal:AbortSignal.timeout(20000)});
  const body=await response.arrayBuffer();
  expect(response.status,route).toBe(200);
  const groups=route==='/api/my-tasks?v=2'?(JSON.parse(new TextDecoder().decode(body)) as {groups:{next7:{total:number;items:unknown[]};needsNextStep:{total:number;items:{id:string}[];nextCursor:string|null}}}).groups:null;
  return{ms:performance.now()-start,bytes:body.byteLength,groups};
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
  const workingStage=await db.stage.findFirst({where:{category:'ACTIVE',pipeline:{typeId:'wst_deal'}},select:{id:true,pipelineId:true}});
  expect(workingStage,'the seeded disposable database must have an active deal stage').toBeTruthy();
  for(let n=0;n<1000;n++)dealIds.push(`${id}-deal-${n}`);
  await db.project.createMany({data:dealIds.map((dealId,n)=>({id:dealId,workspaceId:workspaces[0].id,name:`${id} deal ${n}`,typeId:'wst_deal',pipelineId:workingStage!.pipelineId,stageId:workingStage!.id}))});
  await db.projectMember.createMany({data:dealIds.map(dealId=>({projectId:dealId,userId:id,role:'LEADER'}))});
  expect(await db.project.count({where:{id:{in:dealIds}}})).toBe(1000);
  // Measure v2 before the legacy endpoint's large response inflates process RSS.
  for(const route of ['/api/auth/me','/api/dashboard?panel=tasks','/api/projects','/api/my-tasks?v=2','/api/my-tasks','/api/search?q='+id,'/api/projects/'+projectIds[0]]){
   const first=await read(route),samples:Awaited<ReturnType<typeof read>>[]=[];
   if(route==='/api/my-tasks?v=2'){
    expect(first.groups?.next7.total).toBe(10000);
    expect(first.groups?.next7.items).toHaveLength(25);
    expect(first.groups?.needsNextStep.total).toBe(1000);
    expect(first.groups?.needsNextStep.items).toHaveLength(25);
   }
   if(queryStatsEnabled)await resetQueryStats();
   const before=serverResource();
   for(let batch=0;batch<2;batch++)samples.push(...await Promise.all(Array.from({length:5},()=>read(route))));
   const after=serverResource();
   const databaseStats=queryStatsEnabled?await queryStats():null;
   const databaseStatements=databaseStats?.calls??null;
   const databaseExecMs=databaseStats?Math.round(databaseStats.totalExecMs):null;
   if(queryStatsEnabled)expect(databaseStatements,`database statements for ${route}`).toBeGreaterThan(0);
   if(queryStatsEnabled)expect(databaseExecMs,`database execution time for ${route}`).toBeGreaterThanOrEqual(0);
   const sorted=samples.map(x=>x.ms).sort((a,b)=>a-b);
   const measurement={route:route.startsWith('/api/search')?'/api/search?q=<fixture>':route.startsWith('/api/projects/')?'/api/projects/<fixture>':route,concurrency:5,samples:sorted.length,firstRequestMs:Math.round(first.ms),p50Ms:Math.round(sorted[4]),p95Ms:Math.round(sorted[9]),maxBytes:Math.max(first.bytes,...samples.map(x=>x.bytes)),databaseStatements,databaseExecMs,serverResource:before&&after&&clockTicksPerSecond?{cpuMs:Math.round((after.cpuTicks-before.cpuTicks)*1000/clockTicksPerSecond),rssBeforeKiB:before.rssKiB,rssAfterKiB:after.rssKiB,highWaterKiB:after.highWaterKiB}:null};
   report.measurements.push(measurement);
   if(route==='/api/my-tasks?v=2'){
    expect(measurement.maxBytes,'approved My Tasks initial response budget').toBeLessThanOrEqual(512*1024);
    expect(sorted[9],'approved My Tasks p95 budget at five concurrent reads').toBeLessThanOrEqual(1000);
    const seen=new Set(first.groups!.needsNextStep.items.map(row=>row.id));
    let cursor=first.groups!.needsNextStep.nextCursor;
    let pages=1;
    while(cursor){
     const response=await fetch(new URL(`/api/my-tasks?v=2&group=needsNextStep&cursor=${encodeURIComponent(cursor)}`,base),{headers:{cookie:'sho_session='+raw},signal:AbortSignal.timeout(20000)});
     expect(response.status).toBe(200);
     const body=await response.json() as {page:{items:{id:string}[];total:number;nextCursor:string|null}};
     expect(body.page.total).toBe(1000);
     for(const row of body.page.items){expect(seen.has(row.id),'deal page must not repeat a row').toBe(false);seen.add(row.id);}
     cursor=body.page.nextCursor;
     pages++;
     expect(pages,'deal cursor must terminate').toBeLessThanOrEqual(40);
    }
    expect(seen.size).toBe(1000);
    expect(pages).toBe(40);
    report.dealPaging={pages,uniqueDealIds:seen.size,exactTotal:1000};
    const cursorRow=first.groups!.needsNextStep.items[24].id;
    const pageUrl=new URL(`/api/my-tasks?v=2&group=needsNextStep&cursor=${encodeURIComponent(first.groups!.needsNextStep.nextCursor!)}`,base);
    const beforeArchive=await fetch(pageUrl,{headers:{cookie:'sho_session='+raw}});
    expect(beforeArchive.status).toBe(200);
    const beforePage=await beforeArchive.json() as {page:{items:{id:string}[]}};
    await db.project.update({where:{id:cursorRow},data:{archivedAt:new Date()}});
    const afterArchive=await fetch(pageUrl,{headers:{cookie:'sho_session='+raw}});
    expect(afterArchive.status).toBe(200);
    const afterPage=await afterArchive.json() as {page:{items:{id:string}[];total:number}};
    expect(afterPage.page.total).toBe(999);
    expect(afterPage.page.items[0]?.id).toBe(beforePage.page.items[0]?.id);
    expect(afterPage.page.items.some(row=>row.id===cursorRow)).toBe(false);
    await db.project.update({where:{id:cursorRow},data:{archivedAt:null}});
    report.dealCursorAfterArchive=true;
   }
  }
  if(queryStatsEnabled){
   const resource=serverResource();if(!resource)throw Error('AUDIT_SERVER_RESOURCE_UNAVAILABLE');
   const pid=Number(readFileSync('test-results/performance/server.pid','utf8').trim());
   report.legacyCpuProfile=await profileLegacyReads(pid,()=>read('/api/my-tasks'));
  }
  // Populate the previously empty deals only after the approved My Tasks gate.
  // This is a Deals measurement, with no owner-approved latency/size threshold yet.
  await db.section.createMany({data:dealIds.map(dealId=>({id:`${dealId}-section`,projectId:dealId,name:'To do',position:0}))});
  for(let start=0;start<dealIds.length;start+=100){
   await db.task.createMany({data:dealIds.slice(start,start+100).flatMap(dealId=>Array.from({length:10},(_,n)=>({
    workspaceId:workspaces[0].id,projectId:dealId,sectionId:`${dealId}-section`,
    title:`${id} deal task ${n}`,assigneeId:id,createdById:id,dueDate:new Date(Date.now()+n*86400_000),
   })))});
  }
  expect(await db.task.count({where:{projectId:{in:dealIds}}})).toBe(10000);
  const firstDeals=await read('/api/deals'),dealSamples:Awaited<ReturnType<typeof read>>[]=[];
  for(let batch=0;batch<2;batch++)dealSamples.push(...await Promise.all(Array.from({length:5},()=>read('/api/deals'))));
  const dealTimes=dealSamples.map(x=>x.ms).sort((a,b)=>a-b);
  const response=await fetch(new URL('/api/deals',base),{headers:{cookie:'sho_session='+raw},signal:AbortSignal.timeout(20000)});
  expect(response.status).toBe(200);
  const owned=(await response.json() as {deals:{id:string;nextStep:{id:string}|null}[]}).deals.filter(row=>dealIds.includes(row.id));
  expect(owned).toHaveLength(1000);
  expect(owned.every(row=>row.nextStep?.id)).toBe(true);
  report.dealList={dealCount:owned.length,eligibleTasks:10000,firstRequestMs:Math.round(firstDeals.ms),p95Ms:Math.round(dealTimes[9]),maxBytes:Math.max(firstDeals.bytes,...dealSamples.map(x=>x.bytes))};
  const raceTask=await db.task.findFirstOrThrow({where:{projectId:projectIds[0]},orderBy:{id:'asc'}});
  const raceActionsBefore=await db.actionLog.count({where:{targetId:raceTask.id}});
  const raceTitles=Array.from({length:20},(_,n)=>`${id} concurrent edit ${n}`);
  const raceResponses=await Promise.all(raceTitles.map(async title=>{
   const response=await fetch(new URL(`/api/tasks/${raceTask.id}`,base),{method:'PATCH',headers:{cookie:'sho_session='+raw,'content-type':'application/json'},body:JSON.stringify({title,expectedUpdatedAt:raceTask.updatedAt.toISOString()}),signal:AbortSignal.timeout(20000)});
   return{title,status:response.status};
  }));
  const accepted=raceResponses.filter(row=>row.status===200);
  const refused=raceResponses.filter(row=>row.status===409);
  expect(accepted,'exactly one edit may consume the original version').toHaveLength(1);
  expect(refused,'every other edit must get a conflict').toHaveLength(19);
  const afterRace=await db.task.findUniqueOrThrow({where:{id:raceTask.id}});
  expect(afterRace.title).toBe(accepted[0].title);
  expect(afterRace.updatedAt.getTime()).toBeGreaterThan(raceTask.updatedAt.getTime());
  expect(await db.actionLog.count({where:{targetId:raceTask.id}})).toBe(raceActionsBefore+1);
  report.concurrentEdits={requests:20,accepted:accepted.length,conflicts:refused.length,lostUpdates:0};
  report.status='MY_TASKS_TARGET_PASS';
 }finally{
  try{
   if(created){
    const ownedProjects=[...projectIds,...dealIds];
    await db.notification.deleteMany({where:{OR:[{projectId:{in:ownedProjects}},{actorId:id},{recipientId:id}]}});
    await db.actionLog.deleteMany({where:{OR:[{projectId:{in:ownedProjects}},{actorId:id}]}});
    await db.auditLog.deleteMany({where:{actorId:id}});
    await db.task.deleteMany({where:{projectId:{in:ownedProjects}}});
    await db.section.deleteMany({where:{projectId:{in:dealIds}}});
    await db.project.deleteMany({where:{id:{in:ownedProjects}}});
    await db.user.delete({where:{id}});
   }
   expect(await db.project.count({where:{id:{in:projectIds}}})).toBe(0);
   expect(await db.task.count({where:{projectId:{in:projectIds}}})).toBe(0);
   expect(await db.project.count({where:{id:{in:dealIds}}})).toBe(0);
   expect(await db.task.count({where:{projectId:{in:dealIds}}})).toBe(0);
   expect(await db.actionLog.count({where:{actorId:id}})).toBe(0);
   expect(await db.notification.count({where:{OR:[{actorId:id},{recipientId:id}]}})).toBe(0);
   expect(await db.auditLog.count({where:{actorId:id}})).toBe(0);
   expect(await db.project.count()).toBe(originalProjects);
   expect(await db.user.count()).toBe(originalUsers);
   report.cleanup=true;
  }finally{
   mkdirSync('test-results/performance',{recursive:true});writeFileSync('test-results/performance/baseline.json',JSON.stringify(report,null,2)+'\n');
   // CI's retained artifact is not always reachable from the audit workspace.
   // This aggregate contains no fixture id, email, token or record content.
   console.log('PERFORMANCE_BASELINE '+JSON.stringify(report));
  }
 }
},240000);
