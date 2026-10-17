"use client";
import { useState } from "react";
import { api, useGet } from "@/components/api";
import { Page, useMe } from "../Shell";

type Row = { id: string; at: string; who: string | null; email: string | null; event: string; ip: string | null; target: string | null };
type Res = { events: string[]; items: Row[]; nextCursor: string | null };

export default function AuditView() {
  const me = useMe();
  const [person, setPerson] = useState(""); const [event, setEvent] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const qs = new URLSearchParams(Object.entries({ person, event, from, to }).filter(([, v]) => v)).toString();
  const team = useGet<{ people: { id: string; name: string }[] }>("/api/team");
  const a = useGet<Res>(me.orgRole === "SUPER_ADMIN" ? `/api/audit${qs ? `?${qs}` : ""}` : null);
  const [more, setMore] = useState<{ key: string; rows: Row[]; next: string | null } | null>(null);
  if (me.orgRole !== "SUPER_ADMIN") return <Page title="This page isn't available"><div className="card empty">Only the Super Admin can see the audit log.</div></Page>;
  const extra = more?.key === qs ? more : null;
  const rows = [...(a.data?.items ?? []), ...(extra?.rows ?? [])];
  const next = extra ? extra.next : a.data?.nextCursor;
  return (
    <Page title="Audit log" sub="Sign-ins, role changes and other sensitive events. Kept 12 months.">
      <div className="card" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <label className="field" style={{ margin: 0 }}><span className="lbl">Person</span>
          <select className="in" value={person} onChange={(e) => setPerson(e.target.value)}><option value="">Everyone</option>{team.data?.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="field" style={{ margin: 0 }}><span className="lbl">Event</span>
          <select className="in" value={event} onChange={(e) => setEvent(e.target.value)}><option value="">All events</option>{a.data?.events.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="field" style={{ margin: 0 }}><span className="lbl">From</span><input className="in" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field" style={{ margin: 0 }}><span className="lbl">To</span><input className="in" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {a.loading && <div className="skel">Loading…</div>}
      {a.data && !rows.length && <div className="card empty">No events match.</div>}
      {!!rows.length && (
        <div className="scroll">
          <table className="tbl stack">
            <thead><tr><th>When (IST)</th><th>Who</th><th>Event</th><th>IP</th><th>Target</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</td>
                  <td>{r.who ?? "—"}{r.email && <div className="hint">{r.email}</div>}</td>
                  <td><span className="chip">{r.event}</span></td>
                  <td>{r.ip ?? ""}</td>
                  <td className="hint">{r.target ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next && <p><button className="btn ghost" onClick={async () => { const r = await api<Res>("GET", `/api/audit?${qs ? qs + "&" : ""}cursor=${next}`); if (r.ok) setMore({ key: qs, rows: [...(extra?.rows ?? []), ...r.data.items], next: r.data.nextCursor }); }}>Load more</button></p>}
    </Page>
  );
}
