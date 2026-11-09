'use client';
import {useEffect,useState} from 'react';
type Choice={id:string;name:string;role:string;original:boolean};
export function WorkspaceSwitcher({recovery=false}:{recovery?:boolean}){
 const [choices,setChoices]=useState<Choice[]>([]),[selected,setSelected]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),5000);
  fetch('/api/workspaces',{cache:'no-store',signal:controller.signal}).then(async r=>{if(!r.ok)throw Error();return r.json();}).then(data=>{
   setChoices(data.workspaces);setSelected(data.available?data.selected:'');
  }).catch(()=>setError('Workspaces could not be loaded. Refresh to retry.')).finally(()=>clearTimeout(timer));
  return()=>{clearTimeout(timer);controller.abort();};
 },[]);
 async function choose(id:string){
  if(!id || busy)return;setBusy(true);setError('');
  try{const r=await fetch('/api/workspaces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspaceId:id}),signal:AbortSignal.timeout(5000)});
   if(!r.ok)throw Error();
   // Discard the previous workspace's entire client/RSC cache at this authority boundary.
   // eslint-disable-next-line @next/next/no-location-assign-relative-destination
   window.location.assign('/projects');
  }catch{setError('Workspace is unavailable. Refresh and choose again.');setBusy(false);}
 }
 const control=<div className="workspace-switcher"><label style={{display:'grid',gap:4,fontSize:13}}>Workspace
  <select aria-label="Workspace" value={selected} disabled={busy || !choices.length} onChange={e=>void choose(e.target.value)} style={{maxWidth:220,minHeight:40,padding:'6px 32px 6px 10px'}}>
   <option value="" disabled>Choose workspace</option>{choices.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
  </select></label>{error&&<p role="alert">{error}</p>}</div>;
 return recovery?<main style={{maxWidth:500,margin:'12vh auto',padding:24}}><h1>Choose a workspace</h1><p>Your access to the previous workspace changed.</p>{control}</main>:control;
}
