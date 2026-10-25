// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChangeDealBuyer } from "@/components/ChangeDealBuyer";
import { BuyerAccountPicker } from "@/components/BuyerAccountPicker";
const m=vi.hoisted(()=>({api:vi.fn(),useGet:vi.fn(),orgs:[] as {id:string;name:string}[]}));
vi.mock("@/components/api",()=>({api:m.api,useGet:m.useGet}));
vi.mock("@/components/ui",async()=>{const R=await import('react'); return {Modal:({children}:{children:React.ReactNode})=><div role="dialog">{children}</div>,Field:({label,children}:{label:string;children:(id:string)=>React.ReactNode})=>{const id=R.useId();return <label htmlFor={id}>{label}{children(id)}</label>}}});
let root:Root;const change=vi.fn();
beforeEach(()=>{(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;document.body.innerHTML='<div id="root"></div>';root=createRoot(document.getElementById('root')!);vi.clearAllMocks();m.orgs=[];m.useGet.mockImplementation(()=>({data:{organisations:m.orgs},loading:false,error:null}));});
afterEach(()=>act(()=>root.unmount()));
async function mount(){await act(async()=>root.render(<BuyerAccountPicker value={null} onChange={change}/>));}
async function type(value:string){await act(async()=>{const input=document.querySelector('input')!;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
async function click(text:string){await act(async()=>[...document.querySelectorAll('button')].find(b=>b.textContent?.startsWith(text))!.click());}
it('typing only searches; no Account is silently created and existing match is selected',async()=>{m.orgs=[{id:'old',name:'Buyer'}];await mount();await type(' Buyer ');expect(m.api).not.toHaveBeenCalled();expect(m.useGet).toHaveBeenLastCalledWith('/api/orgs?q=Buyer');await click('Use existing');expect(change).toHaveBeenCalledWith({id:'old',name:'Buyer'});expect(m.api).not.toHaveBeenCalled();});
it('explicit creation selects the linked Account and explains retention on later failure/cancel',async()=>{m.api.mockResolvedValue({ok:true,data:{organisation:{id:'new',name:'New Buyer'}}});await mount();await type(' New Buyer ');await click('Create Account');expect(m.api).toHaveBeenCalledWith('POST','/api/orgs',{name:'New Buyer'});expect(change).toHaveBeenCalledWith({id:'new',name:'New Buyer'});expect(document.querySelector('[role="status"]')?.textContent).toContain('remains available even if this deal is not saved');});
it('server duplicate offers existing Account with no force bypass',async()=>{m.api.mockResolvedValue({ok:false,error:'Already exists',data:{existingId:'existing',existingName:'New Buyer',existingArchived:false}});await mount();await type('New Buyer');await click('Create Account');expect(change).not.toHaveBeenCalled();await click('Use existing');expect(change).toHaveBeenCalledWith({id:'existing',name:'New Buyer'});expect(m.api).toHaveBeenCalledOnce();});
it('archived duplicate cannot be selected and failed request retains typed input',async()=>{m.api.mockResolvedValue({ok:false,error:'Archived duplicate',data:{existingId:'archived',existingArchived:true}});await mount();await type('Archived Buyer');await click('Create Account');expect(document.querySelector('input')!.value).toBe('Archived Buyer');expect(change).not.toHaveBeenCalled();expect([...document.querySelectorAll('button')].some(b=>b.textContent?.startsWith('Use existing'))).toBe(false);});
it('network failure retains input and permits an explicit retry',async()=>{m.api.mockRejectedValue(new Error('offline'));await mount();await type('Retained');await click('Create Account');expect(document.querySelector('input')!.value).toBe('Retained');expect(document.querySelector('[role="alert"]')?.textContent).toContain('search before retrying');expect(change).not.toHaveBeenCalled();});
it('double click sends only one in-flight creation request',async()=>{let resolve!:(value:unknown)=>void;m.api.mockImplementation(()=>new Promise(r=>{resolve=r}));await mount();await type('Concurrent');await act(async()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent?.startsWith('Create Account'))!;b.click();b.click();});expect(m.api).toHaveBeenCalledOnce();await act(async()=>resolve({ok:true,data:{organisation:{id:'one',name:'Concurrent'}}}));});

it('failed Buyer save retains the newly created linked selection and a retention notice',async()=>{
  m.api.mockImplementation(async(method:string)=>method==='POST'?{ok:true,data:{organisation:{id:'new',name:'New Buyer'}}}:{ok:false,error:'Buyer changed. Refresh.'});
  await act(async()=>root.render(<ChangeDealBuyer projectId="deal" buyer={{id:'old',name:'Old'}} onDone={change} onClose={()=>{}}/>));
  await type('New Buyer');await click('Create Account');
  await act(async()=>document.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(m.api).toHaveBeenLastCalledWith('PATCH','/api/projects/deal/buyer',{organisationId:'new',expectedOrganisationId:'old'});
  expect(document.querySelector('select')!.value).toBe('new');expect(document.body.textContent).toContain('remains available even if this deal is not saved');expect(change).not.toHaveBeenCalled();
});
it('cancel after explicit Account creation never deletes the retained Account or saves Buyer',async()=>{
  const close=vi.fn();m.api.mockResolvedValue({ok:true,data:{organisation:{id:'new',name:'New Buyer'}}});
  await act(async()=>root.render(<ChangeDealBuyer projectId="deal" buyer={{id:'old',name:'Old'}} onDone={change} onClose={close}/>));
  await type('New Buyer');await click('Create Account');await click('Cancel');expect(close).toHaveBeenCalledOnce();expect(m.api).toHaveBeenCalledOnce();expect(m.api.mock.calls[0][0]).toBe('POST');expect(change).not.toHaveBeenCalled();
});

it('retained Account notice reflects selecting another existing Buyer after creation',async()=>{
  m.orgs=[{id:'other',name:'Existing Buyer'}];m.api.mockResolvedValue({ok:true,data:{organisation:{id:'new',name:'New Buyer'}}});
  function Form(){const [value,setValue]=useState<{id:string;name:string}|null>(null);return <BuyerAccountPicker value={value} onChange={setValue}/>;}
  await act(async()=>root.render(<Form/>));await type('New Buyer');await click('Create Account');
  expect(document.querySelector('[role="status"]')?.textContent).toContain('saved and selected');
  await act(async()=>{const select=document.querySelector('select')!;select.value='other';select.dispatchEvent(new Event('change',{bubbles:true}));});
  expect(document.querySelector('select')!.value).toBe('other');
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Account “New Buyer” saved. It remains available even if this deal is not saved.');
});
