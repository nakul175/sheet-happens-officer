"use client";
import { finePointer } from "@/components/client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useGet } from "@/components/api";
import { Page, useMe } from "../Shell";

type Hit={id:string;kind:"TASK"|"PROJECT"|"DEAL"|"ORGANISATION"|"CONTACT"|"NOTE";title:string;href:string;matchedField:string;excerpt:string;archived?:boolean;done?:boolean;isIdea?:boolean;assignee?:string;project?:{id:string;name:string};organisation?:{id:string;name:string}};
type LegacyHit=Partial<Hit>&{id:string;name?:string};
type Res={results?:Hit[];projects?:LegacyHit[];tasks?:LegacyHit[];organisations?:LegacyHit[];contacts?:LegacyHit[];notes?:LegacyHit[]};
const label=(k:Hit["kind"])=>({TASK:"Task",PROJECT:"Project",DEAL:"Deal",ORGANISATION:"Organisation",CONTACT:"Contact",NOTE:"Note"})[k];
const legacy=(x:LegacyHit,kind:Hit["kind"]):Hit=>({id:x.id,kind:x.kind??kind,title:x.title??x.name??"Untitled",href:x.href??(kind==="TASK"?`/tasks/${x.id}`:kind==="PROJECT"||kind==="DEAL"?`/projects/${x.id}`:`/accounts/${x.id}`),matchedField:x.matchedField??(kind==="TASK"?"title":kind==="NOTE"?"note":kind==="CONTACT"?"contact":"name"),excerpt:x.excerpt??"",...(x.archived?{archived:true}:{}),...(x.done?{done:true}:{}),...(x.isIdea?{isIdea:true}:{})});

export default function SearchView(){
  const[q,setQ]=useState(""),[debounced,setDebounced]=useState(""),[archived,setArchived]=useState(false),[ideas,setIdeas]=useState(false),me=useMe();
  useEffect(()=>{const t=setTimeout(()=>setDebounced(q.trim()),250);return()=>clearTimeout(t);},[q]);
  const path=debounced.length>=2?`/api/search?q=${encodeURIComponent(debounced)}${archived?"&archived=true":""}${ideas?"&idea=true":""}`:null;
  const r=useGet<Res>(path,{keepPrevious:true});
  const results=r.data?.results??[...(r.data?.projects??[]).map(x=>legacy(x,"PROJECT")),...(r.data?.tasks??[]).map(x=>legacy(x,"TASK")),...(r.data?.organisations??[]).map(x=>legacy(x,"ORGANISATION")),...(r.data?.contacts??[]).map(x=>legacy(x,"CONTACT")),...(r.data?.notes??[]).map(x=>legacy(x,"NOTE"))];
  const none=!!r.data&&!results.length;
  return <Page title="Search" sub="Tasks, projects, deals, accounts, contacts and notes you can see">
    <div className="card" style={{display:"flex",gap:14,flexWrap:"wrap",alignItems:"center",marginBottom:14}}>
      <input className="in" style={{flex:1,minWidth:220}} type="search" autoFocus={finePointer()} placeholder="Search by words or meaning" aria-label="Search" value={q} onChange={e=>setQ(e.target.value)}/>
      <label style={{display:"flex",gap:6,alignItems:"center"}}><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/> Include archived</label>
      {me.crm&&<label style={{display:"flex",gap:6,alignItems:"center"}}><input type="checkbox" checked={ideas} onChange={e=>setIdeas(e.target.checked)}/> Ideas only</label>}
    </div>
    {debounced.length<2&&<div className="card empty">Type at least two letters.</div>}
    {r.error&&<div className="err" role="alert">{r.error}</div>}
    {none&&<div className="card empty">Nothing matches &ldquo;{debounced}&rdquo;{archived?"":". Archived projects are left out unless you tick Include archived"}.</div>}
    {!!results.length&&<><div className="grp">Best matches</div><div className="list">{results.map(x=><Link key={`${x.kind}-${x.id}`} href={x.href} className="item">
      <div className="t"><b>{x.title}</b><small>{label(x.kind)} · matched {x.matchedField}{x.project?` · ${x.project.name}`:""}{x.organisation&&x.kind!=="ORGANISATION"?` · ${x.organisation.name}`:""}</small><span style={{display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{x.excerpt}</span></div>
      {x.isIdea&&<span className="chip gold">Idea</span>}{x.done&&<span className="chip green">Done</span>}{x.archived&&<span className="chip grey">Archived</span>}
    </Link>)}</div></>}
  </Page>;
}
