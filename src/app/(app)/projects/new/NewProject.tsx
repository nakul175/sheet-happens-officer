"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, useGet } from "@/components/api";
import { Field, LoadFailed, Skeleton } from "@/components/ui";
import { Page, useMe } from "../../Shell";
import "../projects.css";

type Person = { id: string; name: string; email?: string; status?: "ACTIVE" | "UNVERIFIED" | "DEACTIVATED" };

export default function NewProject() {
  const breadcrumb = <nav className="project-breadcrumb" aria-label="Breadcrumb"><Link href="/projects">Projects</Link><span aria-hidden="true"> / </span><span>New project</span></nav>;
  const me = useMe();
  const router = useRouter();
  const team = useGet<{ people: Person[] }>("/api/team");
  const verticals = useGet<{ verticals: { id: string; name: string; retired: boolean }[] }>("/api/verticals");
  const [verticalId, setVertical] = useState("");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [leader, setLeader] = useState(me.id);
  const [pick, setPick] = useState<Record<string, "EDITOR" | "VIEWER">>({}); // SHO-US-14.17: people added with the project
  const [find, setFind] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Inactive people (deactivated, or never verified) are not offered. The Leader and you already have a seat.
  const people = (team.data?.people ?? []).filter((p) => (!p.status || p.status === "ACTIVE") && p.id !== me.id && p.id !== leader);
  const shown = people.filter((p) => !find.trim() || (p.name + " " + (p.email ?? "")).toLowerCase().includes(find.trim().toLowerCase()));
  const chosen = people.filter((p) => pick[p.id]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true); setErr(null);
    const members = chosen.map((p) => ({ userId: p.id, role: pick[p.id] }));
    const r = await api("POST", "/api/projects", { name, description: desc || null, leaderId: leader, ...(verticalId ? { verticalId } : {}), ...(members.length ? { members } : {}) });
    setBusy(false);
    if (r.ok) router.push(`/projects/${r.data.project.id}?new=1`); // then it asks for the first task
    else setErr(r.error ?? "Could not create the project.");
  }
  const toggle = (id: string, on: boolean) => setPick((m) => { const n = { ...m }; if (on) n[id] = "EDITOR"; else delete n[id]; return n; });
  if (!team.data && team.failed) {
    return (
      <Page className="bounded-form-page" title="New project" sub="Set up your project and choose who joins." beforeTitle={breadcrumb}>
        <LoadFailed onRetry={team.reload} />
      </Page>
    );
  }
  if (team.loading && !team.data) {
    return (
      <Page className="bounded-form-page" title="New project" sub="Set up your project and choose who joins." beforeTitle={breadcrumb}>
        <Skeleton />
      </Page>
    );
  }
  return (
    <Page className="bounded-form-page" title="New project" sub="Set up your project and choose who joins." beforeTitle={breadcrumb}>
      <form className="card new-project-form" onSubmit={submit} aria-busy={busy}>
        <Field label="Project name *">{(id) => <input id={id} className="in" value={name} maxLength={200} required onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Description (optional)">{(id) => <textarea id={id} className="in" value={desc} onChange={(e) => setDesc(e.target.value)} />}</Field>
        <div className="new-project-pair">
        <Field label="Vertical (optional)" hint="Classification does not add people or change access.">{id => <select id={id} className="in" value={verticalId} onChange={e => setVertical(e.target.value)}><option value="">Unclassified</option>{verticals.data?.verticals?.filter(v => !v.retired).map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select>}</Field>
        <Field label="Leader" hint={leader !== me.id ? "If you choose someone else, you are added as an Editor." : "You will be the Leader."}>
          {(id) => (
            <select id={id} className="in" value={leader} onChange={(e) => setLeader(e.target.value)}>
              {team.data?.people.filter((p) => !p.status || p.status === "ACTIVE").map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === me.id ? " (you)" : ""}</option>)}
            </select>
          )}
        </Field>
        </div>
        <fieldset className="addppl">
          <legend className="lbl">Add people (optional)</legend>
          <p className="hint">They join as Editors. Choose Viewer for read-only. You can add more later from Settings.</p>
          {people.length > 8 && <input className="in" aria-label="Find a person" placeholder="Find a person" value={find} onChange={(e) => setFind(e.target.value)} />}
          <div className="ppl" role="group" aria-label="People">
            {shown.map((p) => (
              <div className="ppl-row" key={p.id}>
                <label className="ppl-l">
                  <input type="checkbox" checked={!!pick[p.id]} onChange={(e) => toggle(p.id, e.target.checked)} />
                  <span>{p.name}</span>
                </label>
                {pick[p.id] && (
                  <select className="in ppl-r" aria-label={`Role of ${p.name}`} value={pick[p.id]} onChange={(e) => setPick((m) => ({ ...m, [p.id]: e.target.value as "EDITOR" | "VIEWER" }))}>
                    <option value="EDITOR">Editor</option><option value="VIEWER">Viewer</option>
                  </select>
                )}
              </div>
            ))}
            {team.data && !shown.length && <p className="hint">{people.length ? "No one matches." : "No one else is available to add yet."}</p>}
          </div>
          {chosen.length > 0 && <p className="hint" role="status">{chosen.length} {chosen.length === 1 ? "person" : "people"} will be added.</p>}
        </fieldset>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="new-project-actions"><Link className="btn ghost" href="/projects">Cancel</Link><button className="btn" type="submit" disabled={busy || !name.trim()}>Create project</button></div>
      </form>
    </Page>
  );
}
