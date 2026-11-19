import {mkdirSync,writeFileSync} from 'node:fs';
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
const stageByDeal=new Map<string,string>();
let stageOrder=new Map<string,number>();
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
 stageOrder=new Map(p.stages.map((stage,index)=>[stage.id,index]));
 firstName=first.name;pausedName=paused.name;
 const o=await sa.c.post('/api/orgs',{name:tag+' Buyer'});expect(o.status).toBe(201);org=o.json.organisation.id;
 const fixtures=[['RFP_RFA',first],['OTC',paused],['RFP_RFA',first],['RFP_RFA',active],['OTC',active],['EOI',paused]] as const;
 const earlyDeadline=istDate(3),lateDeadline=istDate(7);
 for(const [i,[type,stage]] of fixtures.entries()){
  const name=tag+' '+String.fromCharCode(65+i);names.push(name);
  const submissionDeadline=i===0||i===2?earlyDeadline:i===3?lateDeadline:null;
  const r=await sa.c.post('/api/deals',{name,organisationId:org,pipelineId:p.id,leaderId:sa.id,whyPursue:'ZZ-TEST filter acceptance',opportunityType:type,submissionDeadline,nextStep:{title:'ZZ-TEST follow up',dueDate:istDate(3)}});
  expect(r.status,`create fixture${i}`).toBe(201);const id=r.json.deal.id;ids.push(id);
  stageByDeal.set(id,stage.id);
  if(stage.id!==first.id)expect((await sa.c.post(`/api/projects/${id}/stage`,{stageId:stage.id,reason:'ZZ-TEST filter fixture'})).status).toBe(200);
 }
 mkdirSync('test-results/deal-filters',{recursive:true});
 browser=await chromium.launch({executablePath:process.env.PW_CHROMIUM,args:['--no-sandbox']});
},180000);
afterAll(async()=>{
 await browser?.close();
 if(sa&&ids.length)await cleanupZz(ids,[]);
 for(const id of ids){
  const read=await sa.c.get(`/api/projects/${id}`);
  expect(read.status).toBe(200);
  expect(read.json.project.archived).toBe(true);
 }
 if(sa&&org)expect((await sa.c.post(`/api/orgs/${org}/archive`,{archive:true})).status).toBe(200);
 if(sa&&org){const read=await sa.c.get(`/api/orgs/${org}`);expect(read.status).toBe(200);expect(read.json.organisation.archived).toBe(true);}
 expect(ids).toHaveLength(6);expect(org).toBeTruthy();
 writeFileSync('test-results/deal-filters/cleanup.json',JSON.stringify({ownedDeals:ids.length,ownedOrganisation:Boolean(org),archivedReadback:true},null,2));
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
  const sortControl=page.locator('.deal-filter-control select');
  const firstStage=page.locator('section[aria-label="RFP/RFA + OTC sales"] .dcol').filter({has:page.locator('header b').getByText(firstName,{exact:true})});
  const visibleOwnedCards=async()=>firstStage.locator('a[href^="/projects/"]').evaluateAll((links,owned)=>
   links.map(link=>link.getAttribute('href')?.split('/').pop()).filter((id):id is string=>Boolean(id&&owned.includes(id))),ids);
  const expectedStageOrder=[...ids].sort((a,b)=>
   (stageOrder.get(stageByDeal.get(a)!)??Number.MAX_SAFE_INTEGER)-(stageOrder.get(stageByDeal.get(b)!)??Number.MAX_SAFE_INTEGER)||a.localeCompare(b));
  const visibleOwnedBoard=async()=>page.locator('section[aria-label="RFP/RFA + OTC sales"] .dcol a[href^="/projects/"]').evaluateAll((links,owned)=>
   links.map(link=>link.getAttribute('href')?.split('/').pop()).filter((id):id is string=>Boolean(id&&owned.includes(id))),ids);
  await sortControl.selectOption('stage');
  await expect.poll(visibleOwnedBoard).toEqual(expectedStageOrder);
  await sortControl.selectOption('name-desc');
  await expect.poll(visibleOwnedCards).toEqual([ids[2],ids[0]]);
  await sortControl.selectOption('name-asc');
  await expect.poll(visibleOwnedCards).toEqual([ids[0],ids[2]]);
  await control('Opportunity types').locator('summary').click();
  const types=page.getByRole('group',{name:'Opportunity types',exact:true});
  await types.getByRole('checkbox',{name:'RFP/RFA',exact:true}).check();await types.getByRole('checkbox',{name:'OTC',exact:true}).check();
  await control('Stages').locator('summary').click();
  const stages=page.getByRole('group',{name:'Stages',exact:true});
  await stages.getByRole('checkbox',{name:firstName,exact:true}).check();await stages.getByRole('checkbox',{name:pausedName,exact:true}).check();
  await control('Stages').locator('summary').click();
  await waitIds([ids[0],ids[1],ids[2]]);
  expect(await control('Opportunity types').locator('summary').innerText()).toContain('2 selected');
  await page.screenshot({path:`test-results/deal-filters/board-${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'List',exact:true}).click();await waitIds([ids[0],ids[1],ids[2]]);
  await page.screenshot({path:`test-results/deal-filters/list-${width}.png`,fullPage:true});
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();await waitIds(ids);
  const results=page.locator('.deal-results');
  const baselineCount=Number((await results.innerText()).match(/^(\d+) deals/)?.[1]);
  expect(baselineCount).toBeGreaterThanOrEqual(ids.length);
  await page.getByRole('button',{name:'Date filters'}).click();
  await page.getByLabel('No date').selectOption('exclude');
  await waitIds([ids[0],ids[2],ids[3]]);
  expect(Number((await results.innerText()).match(/^(\d+) deals/)?.[1])).toBeLessThan(baselineCount);
  await page.getByLabel('Date basis').selectOption('createdAt');
  await page.getByLabel('From').fill('9999-01-01');
  expect(await results.innerText()).toContain('0 deals');
  expect(await page.getByRole('region',{name:'No matching deals'}).isVisible()).toBe(true);
  await page.getByLabel('From').fill('');
  await page.getByLabel('Date basis').selectOption('submissionDeadline');
  await page.getByLabel('No date').selectOption('only');
  await waitIds([ids[1],ids[4],ids[5]]);
  await page.getByRole('button',{name:'Clear timeline filter'}).click();
  await sortControl.selectOption('name-desc');
  const rows=page.getByRole('table',{name:'RFP/RFA + OTC sales table'}).locator('tbody tr td:first-child a');
  const descending=await rows.allTextContents();
  expect(descending).toEqual([...descending].sort((a,b)=>b.localeCompare(a,'en',{sensitivity:'base'})));
  await sortControl.selectOption('name-asc');
  const ascending=await rows.allTextContents();
  expect(ascending).toEqual([...ascending].sort((a,b)=>a.localeCompare(b,'en',{sensitivity:'base'})));
  const visibleOwnedRows=async()=>rows.evaluateAll((links,owned)=>
   links.map(link=>link.getAttribute('href')?.split('/').pop()).filter((id):id is string=>Boolean(id&&owned.includes(id))),ids);
  await sortControl.selectOption('stage');
  await expect.poll(visibleOwnedRows).toEqual(expectedStageOrder);
  const tiedDates=[ids[0],ids[2]].sort();
  const undated=[ids[1],ids[4]].sort();
  await sortControl.selectOption('date-asc');
  await expect.poll(visibleOwnedRows).toEqual([...tiedDates,ids[3],...undated]);
  await sortControl.selectOption('date-desc');
  await expect.poll(visibleOwnedRows).toEqual([ids[3],...tiedDates,...undated]);
  await page.reload();
  await page.getByRole('tab',{name:pipeName,exact:true}).click();
  await waitIds(ids);
  expect(await results.innerText()).toContain(`${baselineCount} deals`);
  await page.goto('/search');
  await page.goBack();
  await page.getByRole('tab',{name:pipeName,exact:true}).click();
  await waitIds(ids);
  expect(await results.innerText()).toContain(`${baselineCount} deals`);
  writeFileSync(`test-results/deal-filters/verification-${width}.json`,JSON.stringify({width,ownedDeals:ids.length,baselineCount,typeStageIntersection:true,dateEmptyAndRecovery:true,stageSortBoardAndList:true,nameSortBothDirections:true,dateSortBothDirectionsWithNullsAndTies:true,reloadAndBackRecovery:true},null,2));
 }catch(error){await page.screenshot({path:`test-results/deal-filters/failure-${width}.png`,fullPage:true});throw error;}finally{await ctx.close();}
});
