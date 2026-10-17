"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, useGet } from "@/components/api";
import { Field } from "@/components/ui";
import { Page, useMe } from "../../Shell";

export default function NewProject() {
  const me = useMe();
  const router = useRouter();
  const team = useGet<{ people: { id: string; name: string }[] }>("/api/team");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [leader, setLeader] = useState(me.id);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const r = await api("POST", "/api/projects", { name, description: desc || null, leaderId: leader });
    setBusy(false);
    if (r.ok) router.push(`/projects/${r.data.project.id}`);
    else setErr(r.error ?? "Could not create the project.");
  }
  return (
    <Page title="New project" sub={<Link href="/projects">← Projects</Link>}>
      <form className="card" style={{ maxWidth: 560 }} onSubmit={submit}>
        <Field label="Project name">{(id) => <input id={id} className="in" value={name} maxLength={200} required onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Description (optional)">{(id) => <textarea id={id} className="in" value={desc} onChange={(e) => setDesc(e.target.value)} />}</Field>
        <Field label="Leader" hint={leader !== me.id ? "If you choose someone else, you are added as an Editor." : "You will be the Leader."}>
          {(id) => (
            <select id={id} className="in" value={leader} onChange={(e) => setLeader(e.target.value)}>
              {team.data?.people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.id === me.id ? " (you)" : ""}</option>)}
            </select>
          )}
        </Field>
        {err && <div className="err" role="alert">{err}</div>}
        <button className="btn" disabled={busy || !name.trim()}>Create project</button>
      </form>
    </Page>
  );
}
