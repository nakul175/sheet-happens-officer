"use client";
import { useState } from "react";
import { LoadFailed, Skeleton } from "@/components/ui";
import { ago, api, useGet } from "@/components/api";
import { Page, useMe } from "../Shell";

type Row = { id: string; at: string; who: string | null; email: string | null; event: string; ip: string | null; channel: string; target: string | null };
type Res = { events: string[]; items: Row[]; nextCursor: string | null };
type JobRow = { job: string; about: string; lastFinishedAt: string | null; lastStatus: string | null; lastError: string | null };

export default function AuditView() {
  const me = useMe();
  const [person, setPerson] = useState(""); const [event, setEvent] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const qs = new URLSearchParams(Object.entries({ person, event, from, to }).filter(([, v]) => v)).toString();
  const team = useGet<{ people: { id: string; name: string }[] }>("/api/team");
  const a = useGet<Res>(me.orgRole === "SUPER_ADMIN" ? `/api/audit${qs ? `?${qs}` : ""}` : null);
  const jobs = useGet<{ jobs: JobRow[] }>(me.orgRole === "SUPER_ADMIN" ? "/api/jobs" : null);
  // The event list and the rows share one fetch. Remember the last list so the dropdown does not collapse to "All events" while the next filter loads.
  const [knownEvents, setKnownEvents] = useState<string[]>([]);
  if (a.data?.events && a.data.events !== knownEvents) setKnownEvents(a.data.events);
  const events = a.data?.events ?? knownEvents;
  const [more, setMore] = useState<{ key: string; rows: Row[]; next: string | null } | null>(null);
  if (me.orgRole !== "SUPER_ADMIN") return <Page title="This page isn't available"><div className="card empty">Only the Super Admin can see the audit log.</div></Page>;
  const extra = more?.key === qs ? more : null;
  const rows = [...(a.data?.items ?? []), ...(extra?.rows ?? [])];
  const next = extra ? extra.next : a.data?.nextCursor;
  return (
    <Page title="Audit log" sub="Sign-ins, role changes and other sensitive events. Kept 12 months.">
      {jobs.data && (
        <details className="card audit-jobs" style={{ marginBottom: 14 }}>
          <summary>Scheduled jobs</summary>
          <div className="list" style={{ marginTop: 8, border: 0 }}>
            {jobs.data.jobs.map((j) => (
              <div className="item" key={j.job} style={{ padding: "8px 0" }}>
                <div className="t"><b>{j.job}</b><small>{j.about}</small></div>
                <div className="meta">
                  <span>{j.lastFinishedAt ? `Last run ${ago(j.lastFinishedAt)}` : "Never run"}</span>
                  {j.lastStatus && <span className={`chip ${j.lastStatus === "OK" ? "green" : "red"}`} title={j.lastError ?? undefined}>{j.lastStatus}</span>}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="card" style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <label className="field" style={{ margin: 0 }}><span className="lbl">Person</span>
          <select className="in" value={person} onChange={(e) => setPerson(e.target.value)}><option value="">Everyone</option>{team.data?.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
        <label className="field" style={{ margin: 0 }}><span className="lbl">Event</span>
          <select className="in" aria-label="Event" value={event} onChange={(e) => setEvent(e.target.value)}><option value="">All events</option>{events.map((x) => <option key={x}>{x}</option>)}</select></label>
        <label className="field" style={{ margin: 0 }}><span className="lbl">From</span><input className="in" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field" style={{ margin: 0 }}><span className="lbl">To</span><input className="in" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {a.loading && <Skeleton />}
      {!a.data && a.failed && <LoadFailed onRetry={a.reload} />}
      {a.data && !rows.length && <div className="card empty">No events match.</div>}
      {!!rows.length && (
        <div className="scroll">
          <table className="tbl stack">
            <thead><tr><th>When (IST)</th><th>Who</th><th>Event</th><th>IP</th><th>How</th><th>Target</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="When">{new Date(r.at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</td>
                  <td data-label="Who">{r.who ?? "—"}{r.email && <div className="hint">{r.email}</div>}</td>
                  <td data-label="Event"><span className="chip">{r.event}</span></td>
                  <td data-label="IP">{r.ip ?? ""}</td>
                  <td data-label="How">{r.channel === "Concierge" ? <span className="chip gold">via concierge</span> : "on screen"}</td>
                  <td data-label="Target" className="hint">{r.target ?? ""}</td>
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
