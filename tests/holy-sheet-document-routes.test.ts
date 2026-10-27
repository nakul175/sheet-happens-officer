import {beforeEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({user:vi.fn(),documents:vi.fn(),change:vi.fn()}));
vi.mock('next/server',()=>({connection:vi.fn()}));vi.mock('@/lib/auth',()=>({currentUser:m.user}));vi.mock('@/lib/holy-sheet-links',()=>({documents:m.documents,changeDocument:m.change}));
import * as project from '../src/app/api/projects/[id]/documents/route';
import * as task from '../src/app/api/tasks/[id]/documents/route';
import {ApiError} from '../src/lib/http';
const input={pageId:'12345678-1234-4234-8234-123456789abc',subject:'actor'},ctx={params:Promise.resolve({id:'native-source'})};
const req=(method='GET',origin='https://sheethappensofficer.aplyd.org',body:unknown=input)=>new Request('https://sheethappensofficer.aplyd.org/api/source/documents',{method,headers:{origin,'content-type':'application/json'},body:method==='GET'?undefined:JSON.stringify(body)});
beforeEach(()=>{vi.resetAllMocks();m.user.mockResolvedValue({id:'native-actor'});m.documents.mockResolvedValue({links:[]});m.change.mockResolvedValue({ok:true});});
it.each([{name:'project',api:project,kind:'projects'},{name:'task',api:task,kind:'tasks'}])('scopes $name reads and writes to the requested native source',async({api,kind})=>{expect((await api.GET(req(),ctx)).status).toBe(200);expect(m.documents).toHaveBeenCalledWith({id:'native-actor'},{kind,id:'native-source'});expect((await api.POST(req('POST'),ctx)).status).toBe(200);expect(m.change).toHaveBeenCalledWith({id:'native-actor'},{kind,id:'native-source'},{...input,remove:false});expect((await api.DELETE(req('DELETE'),ctx)).headers.get('cache-control')).toContain('no-store');});
it('denies cross-origin intent and malformed references without performing a mutation',async()=>{expect((await task.POST(req('POST','https://other.invalid'),ctx)).status).toBe(403);expect((await task.POST(req('POST','https://sheethappensofficer.aplyd.org',{...input,pageId:'not-a-page'}),ctx)).status).toBe(400);expect(m.change).not.toHaveBeenCalled();});
it('does not emit metadata after authentication or source access fails',async()=>{m.user.mockRejectedValueOnce(new ApiError(401,'Sign in'));const denied=await project.GET(req(),ctx);expect(denied.status).toBe(401);expect(m.documents).not.toHaveBeenCalled();m.documents.mockRejectedValueOnce(new ApiError(404,'Project not found'));const missing=await project.GET(req(),ctx);expect(missing.status).toBe(404);expect(missing.headers.get('cache-control')).toContain('no-store');});

it.each([project,task])('accepts fixed public origin behind the loopback TLS proxy and rejects spoofed forwarding',async api=>{
 const proxied=(origin:string)=>new Request('http://127.0.0.1:3001/api/source/documents',{method:'POST',headers:{origin,'content-type':'application/json','x-forwarded-host':'evil.invalid','x-forwarded-proto':'https'},body:JSON.stringify(input)});
 expect((await api.POST(proxied('https://sheethappensofficer.aplyd.org'),ctx)).status).toBe(200);
 m.change.mockClear();for(const origin of ['http://127.0.0.1:3001','https://evil.invalid','null',''])expect((await api.POST(proxied(origin),ctx)).status).toBe(403);expect(m.change).not.toHaveBeenCalled();
});

it('accepts only the explicitly configured QA origin behind the TLS proxy',async()=>{
 vi.stubEnv('SHO_HOLY_QA','1');vi.stubEnv('APP_URL','https://sho-qa.aplyd.org');vi.stubEnv('SHO_HOLY_QA_SUBJECTS','c9492fe8-38a8-4d67-9063-8f0ebdd2a919');
 try{for(const api of [project,task])for(const method of ['POST','DELETE'] as const){const request=new Request('http://127.0.0.1:3001/api/source/documents',{method,headers:{origin:'https://sho-qa.aplyd.org','content-type':'application/json'},body:JSON.stringify(input)});expect((await api[method](request,ctx)).status).toBe(200);}expect((await task.POST(req('POST'),ctx)).status).toBe(403);}finally{vi.unstubAllEnvs();}
});
