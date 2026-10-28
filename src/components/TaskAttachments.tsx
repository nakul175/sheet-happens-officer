"use client";
import { useEffect, useRef, useState } from "react";
import { api, useGet } from "@/components/api";
type FileRow = {id:string;filename:string;size:number};
export function TaskAttachments({taskId}:{taskId:string}) {
  const list=useGet<{files:FileRow[];canWrite:boolean}>(`/api/tasks/${taskId}/attachments`);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""); const input=useRef<HTMLInputElement>(null);
  const reload=list.reload;
  useEffect(()=>{window.addEventListener("sho:undone",reload);return()=>window.removeEventListener("sho:undone",reload);},[reload]);
  return <section className="card" aria-label="Task files"><h3>Files · development test slice</h3><p className="hint">PDF only. Provisional limits: 25 MB per file, 10 files per task. No preview or virus scanning. Storage is a temporary test stub; files disappear when the server restarts. Production storage and limits await approval.</p>
    {(error || list.error) && <p role="alert">{error || list.error}</p>}
    {list.data?.files.map(file=><div className="item" key={file.id}><a href={`/api/tasks/${taskId}/attachments/${file.id}`}>{file.filename}</a><small>{Math.ceil(file.size/1024)} KB</small>{list.data?.canWrite && <button className="btn ghost" disabled={busy} onClick={async()=>{setBusy(true);const r=await api("DELETE",`/api/tasks/${taskId}/attachments/${file.id}`);setBusy(false);if(r.ok){reload();setError("");}else setError(r.error??"Could not remove file.");}}>Remove</button>}</div>)}
    {list.data?.canWrite && <form onSubmit={async e=>{e.preventDefault();const file=input.current?.files?.[0];if(!file)return;setBusy(true);setError("");try{const form=new FormData();form.set("file",file);const r=await fetch(`/api/tasks/${taskId}/attachments`,{method:"POST",body:form});const data=await r.json();if(!r.ok)setError(data.error??"Could not add file.");else{const undo=r.headers.get("x-undo-id");if(undo)window.dispatchEvent(new CustomEvent("sho:undo",{detail:{id:undo,label:"File added"}}));reload();if(input.current)input.current.value="";}}catch{setError("Could not reach the server.");}finally{setBusy(false);}}}><label>Add PDF<input ref={input} type="file" name="file" accept="application/pdf,.pdf" disabled={busy}/></label><button className="btn" disabled={busy}>Add file</button></form>}
  </section>;
}
export function AttachmentTrash({projectId}:{projectId:string}) {
  const list=useGet<{canWrite:boolean;files:(FileRow & {taskId:string;daysLeft:number})[]}>(`/api/projects/${projectId}/attachments/trash`);
  const [error,setError]=useState("");
  return <section aria-label="Removed files"><h2>Removed files</h2>{(error||list.error)&&<p role="alert">{error||list.error}</p>}{list.data?.files.map(file=><div className="item" key={file.id}><span>{file.filename} · {file.daysLeft} days left</span>{list.data?.canWrite && <button className="btn ghost" onClick={async()=>{const r=await api("POST",`/api/tasks/${file.taskId}/attachments/${file.id}/restore`,{});if(r.ok)list.reload();else setError(r.error??"Could not restore file.");}}>Restore file</button>}</div>)}</section>;
}
