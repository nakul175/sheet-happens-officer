// @vitest-environment jsdom
import {act,type ReactNode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
const m=vi.hoisted(()=>({paths:[] as (string|null)[],role:'LEADER'}));
vi.mock('react',async original=>({...await original<typeof import('react')>(),use:()=>({id:'p'})}));
vi.mock('@/app/(app)/Shell',()=>({Page:({children}:{children:ReactNode})=><main>{children}</main>}));
vi.mock('@/components/api',()=>({ROLE:{LEADER:'Leader'},api:vi.fn(),useGet:(path:string|null)=>{m.paths.push(path);return {data:path==='/api/projects/p'?{project:{id:'p',name:'Project',role:m.role,archived:false,members:[{userId:'leader',name:'Leader',role:'LEADER',active:true}]}}:path?.includes('member-candidates')?{people:[{id:'candidate',name:'Public name'}]}:null,reload:vi.fn()}}}));
import Members from '@/app/(app)/projects/[id]/members/Members';
let root:Root;
beforeEach(()=>{document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);m.paths=[];m.role='LEADER'});afterEach(()=>act(()=>root.unmount()));
it('email lookup displays name-only server result without client email filtering or disclosure',async()=>{await act(async()=>root.render(<Members params={Promise.resolve({id:'p'})}/>));const input=document.querySelector<HTMLInputElement>('[aria-label="Search by name or email"]')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'colleague@aplyd.com');input.dispatchEvent(new Event('input',{bubbles:true}))});expect(m.paths).toContain('/api/projects/p/member-candidates?q=colleague%40aplyd.com');expect(document.body.textContent).toContain('Public name');expect(document.body.textContent).not.toContain('colleague@aplyd.com');expect(Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Add')).toBe(true);expect(m.paths).not.toContain('/api/team');});
it('Viewer renders no candidate search and makes no directory request',async()=>{m.role='VIEWER';await act(async()=>root.render(<Members params={Promise.resolve({id:'p'})}/>));expect(document.querySelector('[aria-label="Search by name or email"]')).toBeNull();expect(m.paths.some(p=>p?.includes('member-candidates'))).toBe(false)});
