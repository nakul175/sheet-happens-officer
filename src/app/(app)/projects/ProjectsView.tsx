"use client";
import Link from "next/link";
import { useState } from "react";
import { ROLE, api, useGet } from "@/components/api";
import { LoadFailed, Skeleton } from "@/components/ui";
import { Page, useMe } from "../Shell";

type Pr = { id: string; name: string; description: string | null; archived: boolean; leader: { id: string; name: string } | null; openTasks: number; role: string | null; myRole: string | null };

function Card({ p, admin }: { p: Pr; admin: boolean }) {
  return (
    <Link href={`/projects/${p.id}`} className="card pcard">
      <h2>{p.name}</h2>
      <p>{p.description || "No description"}</p>
      <div className="meta" style={{ justifyContent: "flex-start" }}>
        <span className="chip">{p.myRole ? `You: ${ROLE[p.myRole]}` : admin ? "Admin view" : "Member"}</span>
        <span>Leader: {p.leader?.name ?? "none"}</span>
        <span>{p.openTasks} open task{p.openTasks === 1 ? "" : "s"}</span>
        {p.archived && <span className="chip grey">Read-only</span>}
      </div>
    </Link>
  );
}

/** SHO-US-14.4 AC4: no projects yet. Names the Leaders and lets the person ask one of them, which tells that Leader. */
function Leaders() {
  const l = useGet<{ kind: "LEADER" | "ADMIN"; people: { id: string; name: string }[] }>("/api/leaders");
  const [sent, setSent] = useState<Record<string, string>>({});
  const [all, setAll] = useState(false);
  async function ask(id: string) {
    const r = await api("POST", `/api/leaders/${id}/request`, {});
    setSent((x) => ({ ...x, [id]: r.ok ? "Asked. They have been told." : r.error ?? "Could not send that." }));
  }
  if (!l.data?.people.length) return null;
  return (
    <div className="lead-list" aria-label={l.data.kind === "LEADER" ? "Leaders" : "Admins"}>
      <b>{l.data.kind === "LEADER" ? "Leaders you can ask" : "Admins you can ask"}</b>
      {l.data.people.slice(0, all ? undefined : 6).map((p) => (
        <div className="item" key={p.id}>
          <div className="t"><b>{p.name}</b></div>
          {sent[p.id] ? <span className="hint" role="status">{sent[p.id]}</span> : <button className="btn ghost sm" onClick={() => ask(p.id)}>Request to be added</button>}
        </div>
      ))}
      {!all && l.data.people.length > 6 && <button className="btn ghost sm" onClick={() => setAll(true)}>Show all {l.data.people.length}</button>}
    </div>
  );
}

export default function ProjectsView() {
  const me = useMe();
  const admin = me.orgRole !== "MEMBER";
  const [all, setAll] = useState(false);
  const live = useGet<{ projects: Pr[] }>("/api/projects");
  const old = useGet<{ projects: Pr[] }>("/api/projects?archived=true");
  const show = (l: Pr[] | undefined) => (l ?? []).filter((p) => all || p.myRole);
  const active = show(live.data?.projects);
  const archived = show(old.data?.projects);
  return (
    <Page dock title="Projects" sub="Every project you belong to"
      actions={
        <>
          {admin && (
            <div className="seg" role="group" aria-label="Which projects">
              <button aria-pressed={!all} onClick={() => setAll(false)}>Mine</button>
              <button aria-pressed={all} onClick={() => setAll(true)}>All projects</button>
            </div>
          )}
          <Link className="btn" href="/projects/new">+ New project</Link>
        </>
      }>
      {(live.loading || old.loading) && <Skeleton />}
      {live.error && !live.data && <LoadFailed onRetry={live.reload} />}
      {live.error && live.data && <div className="err" role="alert">{live.error} <button className="link" onClick={live.reload}>Retry</button></div>}
      {live.data && active.length === 0 && (
        <div className="card empty">
          {admin
            ? <><b>No projects yet.</b><br />Create one to start adding tasks.</>
            : <><b>Ask a project Leader to add you.</b><br />Projects you are added to show up here. You can also create a project of your own.<Leaders /></>}
        </div>
      )}
      <div className="cards">{active.map((p) => <Card key={p.id} p={p} admin={admin} />)}</div>
      {archived.length > 0 && (
        <>
          <div className="grp">Archived (read-only)</div>
          <div className="cards">{archived.map((p) => <Card key={p.id} p={p} admin={admin} />)}</div>
        </>
      )}
    </Page>
  );
}
