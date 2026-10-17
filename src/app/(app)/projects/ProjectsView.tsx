"use client";
import Link from "next/link";
import { useState } from "react";
import { ROLE, useGet } from "@/components/api";
import { Page, useMe } from "../Shell";

type Pr = { id: string; name: string; description: string | null; archived: boolean; leader: { id: string; name: string } | null; openTasks: number; role: string | null; myRole: string | null };

function Card({ p, admin }: { p: Pr; admin: boolean }) {
  return (
    <Link href={`/projects/${p.id}`} className="card pcard">
      <h3>{p.name}</h3>
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
      {(live.loading || old.loading) && <div className="skel">Loading…</div>}
      {live.error && <div className="err" role="alert">{live.error}</div>}
      {live.data && active.length === 0 && (
        <div className="card empty">
          {admin
            ? <><b>No projects yet.</b><br />Create one to start adding tasks.</>
            : <><b>Ask a project Leader to add you.</b><br />Projects you are added to show up here. You can also create a project of your own.</>}
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
