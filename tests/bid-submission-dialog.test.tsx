// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { StageDialog } from '@/components/DealPanel';
it('3049 stage refusal can be resolved with typed zero revenue/probability and canonical entity', async () => {
  document.body.innerHTML='<div id="root"></div>';
  window.matchMedia=vi.fn().mockReturnValue({matches:false,addEventListener(){},removeEventListener(){}});
  let body: unknown;
  vi.stubGlobal('fetch',vi.fn(async (_url,init) => {body=JSON.parse(init.body);return new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json'}});}));
  const root=createRoot(document.getElementById('root')!); const done=vi.fn();
  try {
    await act(async()=>root.render(h(StageDialog,{projectId:'owned',stage:{id:'st_bid_submitted',name:'Submitted',category:'ACTIVE',needsReason:false,requiredFields:[]},deal:{details:null},initial:{need:['netFeeRevenueUsd','probability','athenaEntity']},onClose:vi.fn(),onDone:done})));
    for(const label of ['NFR (USD) (required)','PWin (%) (required)']) {
      const el=[...document.querySelectorAll('label')].find(x=>x.textContent===label)!;
      const input=document.getElementById(el.htmlFor) as HTMLInputElement;
      expect(input.type).toBe('number');
      await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'0');input.dispatchEvent(new Event('input',{bubbles:true}));});
    }
    const select=document.querySelector('select')!;
    expect([...select.options].some(o=>o.value==='ATHENA_INDIA'&&o.text==='Athena India')).toBe(true);
    await act(async()=>{select.value='ATHENA_INDIA';select.dispatchEvent(new Event('change',{bubbles:true}));});
    const submit=[...document.querySelectorAll('button')].find(b=>b.textContent==='Move deal')!;
    await act(async()=>submit.click());
    expect(body).toEqual({stageId:'st_bid_submitted',fields:{netFeeRevenueUsd:0,probability:0,athenaEntity:'ATHENA_INDIA'}});
    expect(done).toHaveBeenCalledOnce();
  } finally {await act(async()=>root.unmount());vi.unstubAllGlobals();vi.restoreAllMocks();}
});
