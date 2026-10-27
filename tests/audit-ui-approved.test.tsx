// @vitest-environment jsdom
import {act,createElement as h,useState} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {Pri,SectionSelection} from '../src/components/TaskParts';
import {Modal} from '../src/components/ui';
let root:Root;
async function mount(node:React.ReactNode){document.body.innerHTML='<div id="root"></div>';await act(async()=>{root=createRoot(document.getElementById('root')!);root.render(node);});}
afterEach(()=>{act(()=>root?.unmount());vi.restoreAllMocks();});
it('all four original priorities have visible words and distinct non-color icons, with a safe unset display',async()=>{
 await mount(h('div',null,...['LOW','MEDIUM','HIGH','URGENT',''].map(p=>h(Pri,{p,key:p}))));
 expect([...document.querySelectorAll('.pri-t')].map(x=>x.textContent)).toEqual(['Low','Medium','High','Urgent','Not set']);
 expect([...document.querySelectorAll('.priority-badge > [aria-hidden]')].map(x=>x.textContent)).toEqual(['↓','−','↑','⚠','−']);
});
it('an empty or disabled section cannot select tasks',async()=>{
 const change=vi.fn();await mount(h(SectionSelection,{selected:0,total:0,label:'Select empty',onChange:change}));
 const input=document.querySelector<HTMLInputElement>('input')!;expect(input.disabled).toBe(true);await act(async()=>input.click());expect(change).not.toHaveBeenCalled();
});
it('dialog form, native validation, unsaved input and external submit association survive an error message',async()=>{
 function Form(){const[error,setError]=useState(false);return h(Modal,{label:'Example',onClose:()=>{},children:[h('form',{id:'example',key:'form',onSubmit:(e)=>{e.preventDefault();setError(true);}},h('h2',null,'Example form'),h('input',{'aria-label':'Name',defaultValue:'Initial',required:true})),error&&h('p',{role:'alert',key:'error'},'Retry this request'),h('div',{className:'actions',key:'actions'},h('button',{type:'submit',form:'example'},'Save'))]});}
 await mount(h(Form));const input=document.querySelector<HTMLInputElement>('input')!;input.value='Unsaved title';
 expect(document.querySelector('.dialog-header h2')).not.toBeNull();expect(document.querySelector('.dialog-body input')).toBe(input);
 const button=document.querySelector<HTMLButtonElement>('.dialog-footer button')!;expect(button.form).toBe(document.querySelector('form'));
 await act(async()=>button.click());expect(document.querySelector('[role="alert"]')!.textContent).toBe('Retry this request');expect(document.querySelector('input')).toBe(input);expect(input.value).toBe('Unsaved title');
});
it('a task sheet keeps its action region outside the independently scrolling details body',async()=>{
 await mount(h(Modal,{label:'Task',onClose:()=>{},children:h('div',{className:'task-details'},h('div',{className:'bar'},'Task context'),h('textarea',{id:'desc',defaultValue:'Unsaved description'}),h('div',{className:'actions'},h('button',null,'Mark complete')))}));
 const task=document.querySelector('.dialog-task-layout')!;
 expect(task.querySelector(':scope > .dialog-body #desc')).not.toBeNull();
 expect(task.querySelector(':scope > .dialog-footer .actions')!.textContent).toBe('Mark complete');
 expect(task.querySelector(':scope > .dialog-body .actions')).toBeNull();
});
