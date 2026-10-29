import {mkdirSync} from 'node:fs';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {chromium,type Browser} from 'playwright-core';
import {superAdmin,cleanupZz,istDate,type Account} from './helpers';
// SHO-3134 regression: opening Stage after selecting types must work at phone widths.
// Native pointer targeting reproduced the pre-fix failure; use only an isolated local test app/database.
type Stage={id:string;name:string;category:string;isRetired?:boolean};
type Pipeline={id:string;key:string;name:string;stages:Stage[]};
const base=process.env.TASKBOARD_URL!;
let sa:Account,browser:Browser,org='',pipeName='',firstName='',pausedName='';
const ids:string[]=[],names:string[]=[];
const tag=`ZZ-TEST 3134 ${Date.now()}`;
beforeAll(async()=>{
 expect(['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname)).toBe(true);
 const database=new URL(process.env.DATABASE_URL!);
 expect(['127.0.0.1','localhost','[::1]'].includes(database.hostname)).toBe(true);
 expect(['/sho_test','/sho_staging'].includes(database.pathname)).toBe(true);
 sa=await superAdmin();
 const pipelines=(await sa.c.get('/api/deals/pipelines')).json.pipelines as Pipeline[];
 const p=pipelines.find((x)=>x.key==='DEAL_PROACTIVE');
 if(!p)throw new Error('The isolated fixture requires the canonical Proactive pipeline.');
 pipeName=p.name;
 const first=p.stages.find((s)=>!s.isRetired);
 const paused=p.stages.find((s)=>s.category==='PAUSED'&&!s.isRetired);
 const active=p.stages.find((s)=>s.category==='ACTIVE'&&!s.isRetired&&s.id!==first?.id);
 if(!first||!paused||!active)throw new Error('The isolated fixture requires distinct first/paused/active stages.');
 firstName=first.name;pausedName=paused.name;
 const o=await sa.c.post('/api/orgs',{name:tag+' Buyer'});expect(o.status).toBe(201);org=o.json.organisation.id;
 const fixtures=[['RFP_RFA',first],['OTC',paused],['EOI',first],['RFP_RFA',active],['OTC',active],['EOI',paused]] as const;
 for(const [i,[type,stage]] of fixtures.entries()){
  const name=tag+' '+String.fromCharCode(65+i);names.push(name);
  const r=await sa.c.post('/api/deals',{name,organisationId:org,pipelineId:p.id,leaderId:sa.id,whyPursue:'ZZ-TEST filter acceptance',opportunityType:type,nextStep:{title:'ZZ-TEST follow up',dueDate:istDate(3)}});
  expect(r.status,`create fixture${i}`).toBe(201);const id=r.json.deal.id;ids.push(id);
  if(stage.id!==first.id)expect((await sa.c.post(`/api/projects/${id}/stage`,{stageId:stage.id,reason:'ZZ-TEST filter fixture'})).status).toBe(200);
 }
 mkdirSync('reports/3134-shots',{recursive:true});
 browser=await chromium.launch({executablePath:process.env.PW_CHROMIUM,args:['--no-sandbox']});
},180000);
afterAll(async()=>{
 await browser?.close();
 if(sa&&ids.length)await cleanupZz(ids,[]);
 if(sa&&org)expect((await sa.c.post(`/api/orgs/${org}/archive`,{archive:true})).status).toBe(200);
},120000);
for(const width of [390,1280])it(`Existing opportunity/stage multi-select filters board and list at${width}px`,async()=>{
 const ctx=await browser.newContext({viewport:{width,height:844},baseURL:base});
 const eq=sa.c.cookie.indexOf('=');await ctx.addCookies([{name:sa.c.cookie.slice(0,eq),value:sa.c.cookie.slice(eq+1),url:base}]);
 const page=await ctx.newPage();
 const control=(label:string)=>page.locator('details').filter({has:page.getByRole('group',{name:label,exact:true,includeHidden:true})});
 const waitIds=async(expected:string[])=>{
  await page.waitForFunction(({all,want})=>{
   const links=[...document.querySelectorAll('a')].map(a=>a.getAttribute('href'));
   const actual=all.filter(id=>links.includes('/projects/'+id)).sort();
   return JSON.stringify(actual)===JSON.stringify([...want].sort());
  },{all:ids,want:expected},{timeout:20000});
  const actual=await page.evaluate(all=>all.filter(id=>[...document.querySelectorAll('a')].some(a=>a.getAttribute('href')==='/projects/'+id)),ids);
  expect(actual.sort()).toEqual([...expected].sort());
 };
 try{
  await page.goto('/deals');await page.getByRole('tab',{name:pipeName,exact:true}).click();await waitIds(ids);
  await control('Opportunity types').locator('summary').click();
  const types=page.getByRole('group',{name:'Opportunity types',exact:true});
  await types.getByRole('checkbox',{name:'RFP/RFA',exact:true}).check();await types.getByRole('checkbox',{name:'OTC',exact:true}).check();
  await control('Stages').locator('summary').click();
  const stages=page.getByRole('group',{name:'Stages',exact:true});
  await stages.getByRole('checkbox',{name:firstName,exact:true}).check();await stages.getByRole('checkbox',{name:pausedName,exact:true}).check();
  await control('Stages').locator('summary').click();
  await waitIds([ids[0],ids[1]]);
  expect(await control('Opportunity types').locator('summary').innerText()).toContain('2 selected');
  await page.screenshot({path:`reports/3134-shots/board-${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'List',exact:true}).click();await waitIds([ids[0],ids[1]]);
  await page.screenshot({path:`reports/3134-shots/list-${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();await waitIds(ids);
 }catch(error){await page.screenshot({path:`reports/3134-shots/failure-${width}.png`,fullPage:true});throw error;}finally{await ctx.close();}
});
