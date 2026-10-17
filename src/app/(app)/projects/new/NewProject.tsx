"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, useGet } from "@/components/api";
import { Field } from "@/components/ui";
import { Page, useMe } from "../../Shell";

type Person = { id: string; name: string; email?: string; status?: "ACTIVE" | "UNVERIFIED" | "DEACTIVATED" };

export default function NewProject() {
  const me = useMe();
  const router = useRouter();
  const team = useGet<{ people: Person[] }>("/api/team");
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
    setBusy(true); setErr(null);
    const members = chosen.map((p) => ({ userId: p.id, role: pick[p.id] }));
    const r = await api("POST", "/api/projects", { name, description: desc || null, leaderId: leader, ...(members.length ? { members } : {}) });
    setBusy(false);
    if (r.ok) router.push(`/projects/${r.data.project.id}?new=1`); // then it asks for the first task
    else setErr(r.error ?? "Could not create the project.");
  }
  const toggle = (id: string, on: boolean) => setPick((m) => { const n = { ...m }; if (on) n[id] = "EDITOR"; else delete n[id]; return n; });
  return (
    <Page title="New project" sub={<Link href="/projects">← Projects</Link>}>
      <form className="card" style={{ maxWidth: 560 }} onSubmit={submit}>
        <Field label="Project name">{(id) => <input id={id} className="in" value={name} maxLength={200} required onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Description (optional)">{(id) => <textarea id={id} className="in" value={desc} onChange={(e) => setDesc(e.target.value)} />}</Field>
        <Field label="Leader" hint={leader !== me.id ? "If you choose someone else, you are added as an Editor." : "You will be the Leader."}>
          {(id) => (
            <select id={id} className="in" value={leader} onChange={(e) => setLeader(e.target.value)}>
              {team.data?.people.filter((p) => !p.status || p.status === "ACTIVE").map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === me.id ? " (you)" : ""}</option>)}
            </select>
          )}
        </Field>
        <fieldset className="addppl">
          <legend className="lbl">Add people (optional)</legend>
          <p className="hint">They join as Editors. Choose Viewer for read-only. You can add more later from Members.</p>
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
        <button className="btn" disabled={busy || !name.trim()}>Create project</button>
      </form>
    </Page>
  );
}
