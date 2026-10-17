"use client";
import Link from "next/link";
import { useState } from "react";
import { api, useGet } from "@/components/api";
import { Confirm, Field } from "@/components/ui";
import { Page, roleLabel, useMe } from "../Shell";

type P = { id: string; name: string; email?: string; orgRole?: "MEMBER" | "ADMIN" | "SUPER_ADMIN"; status?: "ACTIVE" | "UNVERIFIED" | "DEACTIVATED" };
const STATUS: Record<string, [string, string]> = { ACTIVE: ["Active", "green"], UNVERIFIED: ["Unverified", "gold"], DEACTIVATED: ["Deactivated", "grey"] };

export default function Team() {
  const me = useMe();
  const t = useGet<{ people: P[] }>("/api/team");
  const [err, setErr] = useState<string | null>(null);
  const [deact, setDeact] = useState<P | null>(null);
  const [done, setDone] = useState<null | { name: string; moved: number; fellBack: string[] }>(null);
  const admin = me.orgRole !== "MEMBER";
  const people = t.data?.people ?? [];
  const active = people.filter((p) => !p.status || p.status === "ACTIVE");

  async function act(p: P, what: "reactivate" | "ADMIN" | "MEMBER") {
    const r = what === "reactivate" ? await api("POST", `/api/team/${p.id}/reactivate`, {}) : await api("PATCH", `/api/team/${p.id}`, { orgRole: what });
    if (r.ok) { setErr(null); t.reload(); } else setErr(r.error ?? "Could not do that.");
  }

  return (
    <Page dock title="Team" sub={admin ? "Everyone in the workspace" : "People you can add to projects"}>
      {err && <div className="err" role="alert">{err}</div>}
      {t.loading && <div className="skel">Loading…</div>}
      {t.error && <div className="err" role="alert">{t.error}</div>}
      {t.data && !admin && (
        <div className="list">{people.map((p) => <div className="item" key={p.id}><span className="av sm">{p.name[0]}</span><div className="t"><b>{p.name}</b></div></div>)}</div>
      )}
      {t.data && admin && (
        <div className="scroll">
          <table className="tbl stack">
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {people.map((p) => {
                const [sl, sc] = STATUS[p.status ?? "ACTIVE"];
                const self = p.id === me.id;
                return (
                  <tr key={p.id}>
                    <td><b style={{ fontWeight: 500 }}>{p.name}</b>{self && " (you)"}</td>
                    <td>{p.email}</td>
                    <td><span className={`chip${p.orgRole === "MEMBER" ? " grey" : ""}`}>{roleLabel(p.orgRole!)}</span></td>
                    <td><span className={`chip ${sc}`}>{sl}</span></td>
                    <td>
                      <span className="pills">
                        {p.status === "ACTIVE" && p.orgRole !== "SUPER_ADMIN" && (
                          me.orgRole === "SUPER_ADMIN"
                            ? p.orgRole === "ADMIN"
                              ? <button className="btn ghost sm" onClick={() => act(p, "MEMBER")}>Make Member</button>
                              : <button className="btn ghost sm" onClick={() => act(p, "ADMIN")}>Make Admin</button>
                            : <span className="hint">Super Admin only</span>
                        )}
                        {p.status === "ACTIVE" && !self && p.orgRole !== "SUPER_ADMIN" && !(me.orgRole === "ADMIN" && p.orgRole === "ADMIN") && (
                          <button className="btn ghost sm" style={{ color: "var(--danger)" }} onClick={() => setDeact(p)}>Deactivate</button>
                        )}
                        {p.status === "DEACTIVATED" && <button className="btn ghost sm" onClick={() => act(p, "reactivate")}>Reactivate</button>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {deact && <Deactivate p={deact} others={active.filter((x) => x.id !== deact.id)} onClose={() => setDeact(null)} onDone={(r) => { setDone({ name: deact.name, moved: r.moved, fellBack: r.fellBack }); setDeact(null); t.reload(); }} />}
      {done && (
        <Confirm title={`${done.name} is deactivated`} yes="Close" onNo={() => setDone(null)} onYes={() => setDone(null)}
          body={`${done.moved} open task${done.moved === 1 ? " was" : "s were"} handed over.`}>
          {done.fellBack.length > 0 && <p className="hint">The Leader took the tasks in {done.fellBack.join(", ")}, because the person you named is not on {done.fellBack.length === 1 ? "that project" : "those projects"}.</p>}
        </Confirm>
      )}
    </Page>
  );
}

function Deactivate({ p, others, onClose, onDone }: { p: P; others: P[]; onClose: () => void; onDone: (r: { moved: number; fellBack: string[] }) => void }) {
  const [to, setTo] = useState("leaders");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [leads, setLeads] = useState<{ id: string; name: string }[]>([]);
  return (
    <Confirm title={`Deactivate ${p.name}?`} yes="Deactivate" danger busy={busy} error={err} onNo={onClose}
      body="They are signed out everywhere and can no longer sign in. Their open tasks must go to someone. Their history stays."
      onYes={async () => { setBusy(true); const r = await api("POST", `/api/team/${p.id}/deactivate`, { reassign: to }); setBusy(false); if (r.ok) onDone({ moved: r.data.moved ?? 0, fellBack: r.data.fellBack ?? [] }); else { setLeads(r.data.leads ?? []); setErr(r.error ?? "Could not deactivate."); } }}>
      <Field label="Who takes their open tasks?">
        {(id) => (
          <select id={id} className="in" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="leaders">The Leader of each project</option>
            {others.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
      </Field>
      <p className="hint">If the person you name is not on a project, that project&apos;s Leader takes those tasks.</p>
      {leads.length > 0 && (
        <div className="box warn">
          <b>{p.name} leads {leads.length === 1 ? "a project" : "projects"}.</b> Hand over the leadership first, then deactivate:
          <ul>{leads.map((l) => <li key={l.id}><Link href={`/projects/${l.id}/members`}>{l.name}: Change leader</Link></li>)}</ul>
        </div>
      )}
    </Confirm>
  );
}
