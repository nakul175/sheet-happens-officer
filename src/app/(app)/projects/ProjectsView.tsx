"use client";
import Link from "next/link";
import { useState } from "react";
import { ROLE, api, useGet } from "@/components/api";
import { Confirm, LoadFailed, Skeleton } from "@/components/ui";
import { Page, useMe } from "../Shell";
import "./projects.css";

type Pr = { id: string; name: string; description: string | null; archived: boolean; isVertical?: boolean; vertical?: { id: string; name: string; retired: boolean } | null; leader: { id: string; name: string } | null; openTasks: number; role: string | null; myRole: string | null };

function Card({ p, admin }: { p: Pr; admin: boolean }) {
  return (
    <Link href={`/projects/${p.id}`} className="card pcard">
      <h2>{p.name}</h2>
      <span className="project-classification">{p.isVertical ? "Vertical board" : p.vertical ? `${p.vertical.name}${p.vertical.retired ? " (retired)" : ""}` : "Unclassified delivery project"}</span>
      <p className="project-description">{p.description || "No description"}</p>
      <div className="project-footer">
        <div className="project-people">
          <span className="project-leader">Leader: {p.leader?.name ?? "none"}</span>
          <span>{p.myRole ? `You: ${ROLE[p.myRole]}` : admin ? "Admin view" : "Member"}</span>
          {p.archived && <span className="project-readonly">Read-only</span>}
        </div>
        <span className="project-task-count"><svg aria-hidden="true" width="20" height="24" viewBox="0 0 20 24" fill="none"><rect x="3" y="2" width="14" height="20" rx="2" stroke="currentColor" strokeWidth="1.7"/><path d="M6 7h8M6 11h8M6 15h5M6 18h3" stroke="currentColor" strokeWidth="1.5"/></svg>{p.openTasks} open task{p.openTasks === 1 ? "" : "s"}</span>
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
  const [kind, setKind] = useState<"delivery" | "vertical">("delivery");
  const [verticalFilter, setVerticalFilter] = useState("");
  const vocabulary = useGet<{ verticals: { id: string; name: string; retired: boolean }[]; suggestions: string[] }>("/api/verticals");
  const [newVertical, setNewVertical] = useState(false);
  const [verticalName, setVerticalName] = useState("");
  const [verticalError, setVerticalError] = useState<string | null>(null);
  const [savingVertical, setSavingVertical] = useState(false);
  const [all, setAll] = useState(false);
  const [restore, setRestore] = useState<Pr | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const trash = useGet<{ projects: Pr[] }>("/api/projects?deleted=true");
  const live = useGet<{ projects: Pr[] }>("/api/projects");
  const old = useGet<{ projects: Pr[] }>("/api/projects?archived=true");
  const show = (l: Pr[] | undefined) => (l ?? []).filter((p) => (all || p.myRole) && (!!p.isVertical === (kind === "vertical")) && (kind === "vertical" || !verticalFilter || (verticalFilter === "unclassified" ? !p.vertical : p.vertical?.id === verticalFilter)));
  const active = show(live.data?.projects);
  const archived = show(old.data?.projects);
  return (
    <Page bar title="Projects" sub="Delivery work and vertical boards"
      actions={
        <>
          {admin && <button className={`btn${kind === "vertical" ? "" : " ghost"}`} onClick={() => { setVerticalName(""); setVerticalError(null); setNewVertical(true); }}>+ New vertical</button>}
          <Link className={`btn${kind === "vertical" ? " ghost" : ""}`} href="/projects/new">+ New project</Link>
        </>
      }>
      <div className="seg projects-tabs" role="group" aria-label="Work area">
        <button aria-pressed={kind === "delivery"} onClick={() => setKind("delivery")}>Delivery projects</button>
        <button aria-pressed={kind === "vertical"} onClick={() => setKind("vertical")}>Vertical task boards</button>
      </div>
      <div className="projects-toolbar">
        <div className="projects-scope">
          {admin && <div className="seg" role="group" aria-label="Which projects">
            <button aria-pressed={!all} onClick={() => setAll(false)}>Mine</button>
            <button aria-pressed={all} onClick={() => setAll(true)}>All projects</button>
          </div>}
          {live.data && <span className="hint" role="status">{active.length} {kind === "vertical" ? (active.length === 1 ? "board" : "boards") : (active.length === 1 ? "project" : "projects")}</span>}
        </div>
      {kind === "delivery" && <label className="projects-filter">Vertical <select value={verticalFilter} onChange={e => setVerticalFilter(e.target.value)}><option value="">All verticals</option><option value="unclassified">Unclassified</option>{vocabulary.data?.verticals?.map(v => <option key={v.id} value={v.id}>{v.name}{v.retired ? " (retired)" : ""}</option>)}</select></label>}
      </div>
      {kind === "vertical" && <p className="projects-helper">Ongoing work, organised by function.</p>}
      <details className="projects-help"><summary>About verticals and access</summary><p>Verticals hold ongoing functional work; delivery projects have their own boards. Classification never changes membership or access. Existing records remain Unclassified until explicitly linked.</p></details>
      {newVertical && <Confirm title="Create a vertical task board" yes="Create vertical" body="Admins manage this vocabulary. You become the board Leader and can add its members separately. No one gains access to linked delivery projects." busy={savingVertical || !verticalName.trim()} error={verticalError} onNo={() => setNewVertical(false)} onYes={async () => {
        setSavingVertical(true); const result = await api("POST", "/api/verticals", { name: verticalName }); setSavingVertical(false);
        if (result.ok) { setNewVertical(false); setKind("vertical"); live.reload(); vocabulary.reload(); } else setVerticalError(result.error ?? "Could not create vertical.");
      }}><label>Vertical name <input className="in" list="vertical-suggestions" maxLength={200} value={verticalName} onChange={e => setVerticalName(e.target.value)} /></label><datalist id="vertical-suggestions">{(vocabulary.data?.suggestions ?? ["Growth", "Marketing", "Founder's Office"]).map(name => <option key={name} value={name} />)}</datalist></Confirm>}
      {(live.loading || old.loading) && <Skeleton />}
      {live.error && !live.data && <LoadFailed onRetry={live.reload} />}
      {live.error && live.data && <div className="err" role="alert">{live.error} <button className="link" onClick={live.reload}>Retry</button></div>}
      {live.data && active.length === 0 && (
        <div className="card empty">
          {kind === "vertical" ? <><b>No vertical task boards in this view.</b><br />An Admin can create one or explicitly reclassify an existing project from Members → Project settings.</> : admin
            ? <><b>No projects yet.</b><br />Create one to start adding tasks.</>
            : <><b>Ask a project Leader to add you.</b><br />Projects you are added to show up here. You can also create a project of your own.<Leaders /></>}
        </div>
      )}
      <div className="cards">{active.map((p) => <Card key={p.id} p={p} admin={admin} />)}</div>
      {archived.length > 0 && (
        <>
          <h2 className="grp">Archived (read-only) · {archived.length}</h2>
          <div className="cards projects-archived">{archived.map((p) => <Card key={p.id} p={p} admin={admin} />)}</div>
        </>
      )}
      {!archived.length && old.data && <div className="projects-no-archived"><h2 className="grp">Archived · 0</h2><p className="hint">No archived {kind === "vertical" ? "vertical boards" : "projects"} in this view.</p></div>}
      {old.error && <LoadFailed onRetry={old.reload} />}
      <section aria-label="Project Trash">
        <h2 className="grp">Trash</h2>
        <p className="hint">Deleted projects stay recoverable. Only their Leader or an Admin can view and restore them. Restoring preserves the previous active or archived state.</p>
        {trash.error && <LoadFailed onRetry={trash.reload} />}
        {trash.data?.projects.map(project => <div className="box" key={project.id}><b>{project.name}</b>{" "}<button className="btn ghost sm" onClick={() => { setRestore(project); setRestoreError(null); }}>Restore project…</button></div>)}
        {trash.data && !trash.data.projects.length && <p className="hint">No deleted projects.</p>}
      </section>
      {restore && <Confirm title={`Restore “${restore.name}”?`} yes="Restore project" body="All preserved work and memberships return. The project returns to its previous active or archived state. Members are notified."
        busy={restoring} error={restoreError} onNo={() => setRestore(null)} onYes={async () => {
          setRestoring(true); const result = await api("POST", `/api/projects/${restore.id}/restore`, {}); setRestoring(false);
          if (result.ok) { setRestore(null); live.reload(); old.reload(); trash.reload(); } else setRestoreError(result.error ?? "Could not restore project.");
        }} />}
    </Page>
  );
}
