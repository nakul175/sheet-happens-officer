"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api, useGet } from "@/components/api";
import { Page } from "../Shell";
import type { CalendarEvent } from "@/lib/calendar";
import "./calendar.css";
const iso = (d: Date) => d.toISOString().slice(0,10);
const shift = (d: Date, days: number) => new Date(d.getTime()+days*86400000);
export default function Calendar() {
  const [date,setDate] = useState(() => new Date(new Date(Date.now()+19800000).toISOString().slice(0,10)+"T00:00:00Z"));
  const [mode,setMode] = useState("month"); const [project,setProject] = useState(""); const [message,setMessage] = useState(""); const [busy,setBusy] = useState(false);
  const first = mode === "month" ? new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)) : shift(date,-((date.getUTCDay()+6)%7));
  const start = mode === "month" ? shift(first,-((first.getUTCDay()+6)%7)) : first;
  const days = mode === "month" ? 42 : 7;
  const events = useGet<{events:CalendarEvent[]}>(`/api/calendar?from=${iso(start)}&to=${iso(shift(start,days-1))}`);
  const reloadEvents = events.reload;
  useEffect(()=>{ const reload = () => reloadEvents(); window.addEventListener("sho:undone",reload); return ()=>window.removeEventListener("sho:undone",reload); },[reloadEvents]);
  async function move(event: CalendarEvent, target: string) {
    if (busy || event.kind !== "task" || target === event.date) return;
    setBusy(true); const r = await api("PATCH",`/api/tasks/${event.id}`,{dueDate:target,expectedUpdatedAt:event.updatedAt}); setBusy(false);
    setMessage(r.ok ? "Due date changed. Use Undo to reverse it." : r.status === 409 ? "This task changed since you loaded it. Calendar refreshed; check its latest date before trying again." : r.error ?? "Could not move task."); events.reload();
  }
  const projects = [...new Map((events.data?.events ?? []).map(e=>[e.projectId,e.projectName])).entries()];
  const visible = (events.data?.events ?? []).filter(e=>!project || e.projectId === project);
  return <Page title="Calendar" sub="Your assigned and collaborating tasks, plus submission deadlines for your deals.">
    <div className="pills"><button className="btn ghost" onClick={()=>setDate(mode === "month" ? new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()-1,1)) : shift(date,-7))}>Previous</button><strong>{date.toLocaleDateString("en-GB",{month:"long",year:"numeric",timeZone:"UTC"})}</strong><button className="btn ghost" onClick={()=>setDate(mode === "month" ? new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)) : shift(date,7))}>Next</button>
      <label>View <select className="in" value={mode} onChange={e=>setMode(e.target.value)}><option value="month">Month</option><option value="week">Week</option></select></label>
      <label>Project / deal <select className="in" value={project} onChange={e=>setProject(e.target.value)}><option value="">All</option>{projects.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label>
    </div>
    <p className="hint">Drag a task to another day, or use its date field. Dates follow India time. <Link href="/profile">Subscribe in Outlook</Link></p>
    {(message || events.error) && <p role="status">{events.error ?? message}</p>}{events.loading && <p role="status">Loading calendar…</p>}
    <div className="calendar-grid" aria-label={`${mode} calendar`}>
      {Array.from({length:days},(_,i)=>{ const day = iso(shift(start,i)); const entries=visible.filter(e=>e.date===day); return <section className="calendar-day" key={day} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault(); const item=visible.find(x=>x.id===e.dataTransfer.getData("text/plain")); if(item) void move(item,day);}}><h2><time dateTime={day}>{shift(start,i).toLocaleDateString("en-GB",{weekday:"short",day:"numeric",month:"short",timeZone:"UTC"})}</time></h2>{entries.map(event=><article className="calendar-event" key={`${event.kind}-${event.id}`} draggable={event.kind==="task" && !busy} onDragStart={e=>e.dataTransfer.setData("text/plain",event.id)}><Link href={event.href}>{event.title}</Link><small>{event.projectName}{event.kind==="deadline" ? " · Submission" : ""}</small>{event.kind==="task" && <label className="calendar-date">Due date<input type="date" aria-label={`Due date for ${event.title}`} value={event.date} disabled={busy} onChange={e=>{if(e.target.value) void move(event,e.target.value);}} /></label>}</article>)}</section>;})}
    </div>
    {!events.loading && !visible.length && <p>No dated tasks or submission deadlines in this period.</p>}
  </Page>;
}
