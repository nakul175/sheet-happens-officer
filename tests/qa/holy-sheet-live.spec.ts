import {test,expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const SHO='https://sho-qa.aplyd.org',HS='https://staging.holysheet.aplyd.org';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
// No production target, role provisioning, bearer token, cookie import or trace.
test('SHO-3062 paired normal-login qualification and HOLY-4 AC16',async({browser})=>{
 test.setTimeout(600000);
 if(process.env.HOLY_QA_LIVE!=='1'||!process.env.HOLY_QA_LOGIN_FILE)throw Error('Explicit isolated live QA configuration required');
 const fixture=JSON.parse(await readFile(process.env.HOLY_QA_LOGIN_FILE,'utf8'));
 if(typeof fixture.email!=='string'||typeof fixture.password!=='string'||!fixture.password||!fixture.nativeId||!fixture.subject||!fixture.sharedPageId)throw Error('Incomplete private synthetic fixture');
 const mask=(value:string)=>console.log(`::add-mask::${value}`);[fixture.email,fixture.password,fixture.nativeId,fixture.subject,fixture.sharedPageId].forEach(mask);
 const ctx=await browser.newContext({httpCredentials:{origin:SHO,username:process.env.STAGING_USER!,password:process.env.STAGING_PASS!},recordVideo:undefined});
 ctx.setDefaultTimeout(30000);ctx.setDefaultNavigationTimeout(45000);
 const page=await ctx.newPage(),results:{mapping:string;result:string}[]=[];
 const projectName=`ZZ-TEST HOLY3062 ${Date.now()}`;let projectId='',createdPageId='',taskId='';
 async function call(method:string,path:string,data?:unknown){return ctx.request.fetch(SHO+path,{method,headers:{Origin:SHO},data});}
 async function hsDocument(id:string){return ctx.request.get(`${HS}/api/v1/pages/${id}/document`);}
 async function renewHs(){const auth=await ctx.newPage();await auth.goto(`${HS}/auth/sign-in?next=%2F`);await auth.waitForURL(url=>url.origin===HS&&!url.pathname.startsWith('/auth/'),{timeout:45000});const session=await ctx.request.get(HS+'/auth/session');expect(session.status()).toBe(200);expect((await session.json()).userId).toBe(fixture.subject);await auth.close();}
 async function metadata(kind:'projects'|'tasks',id:string){const response=await call('GET',`/api/${kind}/${id}/documents`);expect(response.status()).toBe(200);return response.json();}
 function docs(){return page.getByRole('region',{name:'Holy Sheet documents',exact:true});}
 function picker(){return page.frameLocator('iframe[title="Choose Holy Sheet page"]');}
 function editor(){return page.frameLocator('iframe[title="Holy Sheet document"]');}
 const receipts:{projectId?:string;taskId?:string;createdPageId?:string;sharedPageId?:string}={sharedPageId:fixture.sharedPageId};
 async function step(name:string,body:()=>Promise<void>){console.log('QA_STEP '+name);await test.step(name,body);}
 try{
  await step('Normal QA RP login, exact release and native binding',async()=>{
   const health=await ctx.request.get(`${SHO}/api/health`);expect(health.status()).toBe(200);expect((await health.json()).release).toBe(process.env.HOLY_QA_EXPECTED_SHO_SHA);
   await page.goto(`${SHO}/api/auth/aplyd/start?next=%2Fprojects`);
   await page.getByLabel('Work email',{exact:true}).fill(fixture.email);await page.getByLabel('Password',{exact:true}).fill(fixture.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
   await page.waitForURL(url=>url.origin===SHO&&url.pathname==='/projects',{timeout:45000});
   const me=await call('GET','/api/auth/me');expect(me.status()).toBe(200);expect((await me.json()).user.id).toBe(fixture.nativeId);await renewHs();
  });
  await step('SC/TC/MS-SHO-3062-048,049: project entry, permitted space and page creation',async()=>{
   const response=await call('POST','/api/projects',{name:projectName,leaderId:fixture.nativeId});expect(response.status()).toBe(201);projectId=(await response.json()).project.id;mask(projectId);receipts.projectId=projectId;
   await page.goto(`${SHO}/projects/${projectId}`);await docs().getByRole('button',{name:'Create page',exact:true}).click();
   await picker().getByLabel('Workspace',{exact:true}).selectOption({index:1});
   await picker().getByLabel('New space name',{exact:true}).fill(projectName);await picker().getByRole('button',{name:'Create space',exact:true}).click();
   await expect(picker().getByLabel('Space',{exact:true})).not.toHaveValue('');
   await picker().getByLabel('Page title',{exact:true}).fill(projectName+' page');await picker().getByRole('button',{name:'Create and link page',exact:true}).click();
   await expect(editor().getByLabel('Page title',{exact:true})).toHaveValue(projectName+' page',{timeout:30000});
   const state=await metadata('projects',projectId);expect(state.subject).toBe(fixture.subject);expect(state.links).toHaveLength(1);createdPageId=state.links[0].pageId;mask(createdPageId);receipts.createdPageId=createdPageId;expect(state.defaultSpaceId).toBeTruthy();
   results.push({mapping:'SHO-3062-048/049',result:'project create/space/page entry subset passed'});
  });
  await step('SC/TC/MS-SHO-3062-051,052: same page standalone, durable editing and unlink without deletion',async()=>{
   const marker='Paired native SHO editor persistence '+Date.now();await editor().getByRole('textbox',{name:'Document content',exact:true}).fill(marker);
   await expect.poll(async()=>{const response=await hsDocument(createdPageId);return response.ok()&&JSON.stringify(await response.json()).includes(marker);},{timeout:30000}).toBe(true);
   const standalone=await ctx.newPage();await standalone.goto(`${HS}/pages/${createdPageId}`);await expect(standalone.getByRole('textbox',{name:'Document content',exact:true})).toContainText(marker);await standalone.close();
   const before=await ctx.request.get(`${HS}/api/v1/pages/${createdPageId}/sharing`);expect(before.status()).toBe(200);
   await docs().getByRole('button',{name:'Remove link',exact:true}).click();await expect.poll(async()=>(await metadata('projects',projectId)).links.length).toBe(0);expect((await hsDocument(createdPageId)).status()).toBe(200);
   results.push({mapping:'SHO-3062-051/052',result:'same document persisted standalone; native unlink retained HS page'});
  });
  await step('SC/TC/MS-SHO-3062-048,050: task entry inherits the project default',async()=>{
   const made=await call('POST',`/api/projects/${projectId}/tasks`,{title:projectName+' task'});expect(made.status()).toBe(201);taskId=(await made.json()).task.id;mask(taskId);receipts.taskId=taskId;
   const project=await metadata('projects',projectId),task=await metadata('tasks',taskId);expect(task.defaultSpaceId).toBe(project.defaultSpaceId);
   await page.goto(`${SHO}/tasks/${taskId}`);await docs().getByRole('button',{name:'Create page',exact:true}).click();await expect(picker().getByLabel('Space',{exact:true})).toHaveValue(project.defaultSpaceId);
   await docs().getByRole('button',{name:'Close document',exact:true}).click();results.push({mapping:'SHO-3062-048/050',result:'task entry/default subset passed'});
  });
  await step('SC/TC/MS-SHO-3062-051,053 and HOLY-4-047: link an existing allowed private page',async()=>{
   await renewHs();const source=await hsDocument(fixture.sharedPageId);expect(source.status()).toBe(200);const data=await source.json(),document=data.page??data;
   await docs().getByRole('button',{name:'Link existing page',exact:true}).click();await picker().getByLabel('Space',{exact:true}).selectOption('');await picker().getByLabel('Find existing page',{exact:true}).fill(document.title);await picker().getByRole('button',{name:document.title,exact:true}).click();
   await expect(editor().getByLabel('Page title',{exact:true})).toHaveValue(document.title,{timeout:30000});expect((await metadata('tasks',taskId)).links.some((p:{pageId:string})=>p.pageId===fixture.sharedPageId)).toBe(true);
   await page.screenshot({path:'test-results/holy3062-embedded-allowed.png'});
   console.log('HOLY3062_READY_FOR_OWNER_REVOCATION');
   // Coordinator removes only this dummy's grant on the dedicated HOLY4 fixture.
   await expect.poll(async()=>(await hsDocument(fixture.sharedPageId)).status(),{timeout:180000,intervals:[1000,2000,3000]}).toBe(404);
   expect((await ctx.request.get(HS+'/auth/session')).status()).toBe(200);expect((await hsDocument(createdPageId)).status()).toBe(200);
   const native=await metadata('tasks',taskId);expect(native.subject).toBe(fixture.subject);expect(native.links.some((p:{pageId:string})=>p.pageId===fixture.sharedPageId)).toBe(true);
   await expect(editor().getByRole('textbox',{name:'Document content',exact:true})).toHaveCount(0,{timeout:15000});
   const denied=await ctx.request.post(`${HS}/api/v1/pages/${fixture.sharedPageId}/document`,{headers:{Origin:HS},data:{operationId:crypto.randomUUID(),baseVersion:document.version,title:document.title,document:document.document}});expect(denied.status()).toBe(404);
   await page.screenshot({path:'test-results/holy3062-native-member-hs-revoked.png'});
   results.push({mapping:'SHO-3062-053/HOLY-4-047',result:'native membership retained; actual embedded read and save denied after HS revoke; session still valid'});
   console.log('HOLY3062_READY_FOR_OWNER_RESTORE');
   await expect.poll(async()=>(await hsDocument(fixture.sharedPageId)).status(),{timeout:180000,intervals:[1000,2000,3000]}).toBe(200);
   const restored=await(await hsDocument(fixture.sharedPageId)).json();expect((restored.page??restored).version).toBe(document.version);
   results.push({mapping:'SHO-3062-055',result:'live permission-unavailable state subset passed; document unchanged after rejected save'});
  });
 }catch(error){const url=new URL(page.url());console.log('QA_STOP '+url.origin+url.pathname);console.log('QA_LOGIN_FORM '+await page.getByLabel('Work email',{exact:true}).count());console.log('QA_SIGNIN_ERROR '+await page.getByText(/invalid.*(email|password)|incorrect.*password|Account is unavailable|Central sign-in could not finish|temporarily unavailable/i).count());throw error;
 }finally{
  if(projectId){const cleanup=await call('POST',`/api/projects/${projectId}/delete`,{confirmationName:projectName});results.push({mapping:'owned-native-fixture-cleanup',result:cleanup.status()===200?'recoverable project trash':'retained; inspect private receipt'});}
  await writeFile('test-results/holy3062-private-receipt.json',JSON.stringify({...receipts,results},null,2),{mode:0o600});
  await writeFile('test-results/holy3062-public-summary.json',JSON.stringify({sho:process.env.HOLY_QA_EXPECTED_SHO_SHA,results,fixtureFingerprint:sha(fixture.sharedPageId),scope:'one synthetic actor role phases; not full original O/E/V/X W1/W2 manual matrix'},null,2));
  await ctx.close();
 }
});
