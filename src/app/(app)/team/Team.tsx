"use client";
import { personText } from "@/components/PeopleSelect";
import Link from "next/link";
import { useState } from "react";
import { api, useGet } from "@/components/api";
import { Confirm, Field, Modal, Skeleton } from "@/components/ui";
import { Page, roleLabel, useMe } from "../Shell";

import "./team-approved.css";
type P = { id: string; name: string; email?: string; orgRole?: "MEMBER" | "ADMIN" | "SUPER_ADMIN"; leads?: { id: string; name: string }[]; status?: "ACTIVE" | "UNVERIFIED" | "DEACTIVATED" };
const STATUS: Record<string, [string, string]> = { ACTIVE: ["Active", "green"], UNVERIFIED: ["Unverified", "gold"], DEACTIVATED: ["Deactivated", "grey"] };

/**
 * SHO-US-2.4 AC2: the fallback is about the role, not membership. A person who is on the project as a
 * Viewer is still not a Leader or Editor there, so that project's Leader takes the tasks. SHO-3030.
 */
export const FALLBACK_HINT = "If the person you name is not a Leader or Editor on a project, that project's Leader takes those tasks.";

/** The deactivation summary's explanation, naming each project that fell back to its Leader (SHO-3030). */
export function fellBackHint(names: string[]): string {
  return `The Leader took the tasks in ${names.join(", ")}, because the person you named is not a Leader or Editor on ${names.length === 1 ? "that project" : "those projects"}.`;
}

/** SHO-US-14.4 AC3: the projects a person leads (only those the viewer can see). */
function Leads({ p }: { p: P }) {
  if (!p.leads?.length) return null;
  const first = p.leads.slice(0, 2), rest = p.leads.slice(2);
  const projectLink = (l: { id: string; name: string }) => <Link key={l.id} className="chip" href={`/projects/${l.id}`}>{l.name}</Link>;
  return <div className="team-leads" aria-label={`Projects led by ${p.name}`}>{first.map(projectLink)}{rest.length > 0 && <details><summary aria-label={`Show ${rest.length} more projects led by ${p.name}`}>{rest.length} more projects</summary><div>{rest.map(projectLink)}</div></details>}</div>;
}

export default function Team() {
  const me = useMe();
  const t = useGet<{ people: P[] }>("/api/team");
  const [err, setErr] = useState<string | null>(null);
  const [deact, setDeact] = useState<P | null>(null);
  const [done, setDone] = useState<null | { name: string; moved: number; fellBack: string[] }>(null);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState<null | { ok: boolean; text: string }>(null);
  const admin = me.orgRole !== "MEMBER";
  const people = t.data?.people ?? [];
  const active = people.filter((p) => !p.status || p.status === "ACTIVE");

  async function act(p: P, what: "reactivate" | "ADMIN" | "MEMBER") {
    const r = what === "reactivate" ? await api("POST", `/api/team/${p.id}/reactivate`, {}) : await api("PATCH", `/api/team/${p.id}`, { orgRole: what });
    if (r.ok) { setErr(null); t.reload(); } else setErr(r.error ?? "Could not do that.");
  }

  async function resend(p: P) {
    const r = await api<{ emailSent: boolean }>("POST", `/api/team/${p.id}/resend`, {});
    if (!r.ok) { setNote(null); setErr(r.error ?? "Could not resend."); return; }
    setErr(null);
    setNote(r.data.emailSent ? { ok: true, text: `New sign-in details were emailed to ${p.email}. The old password no longer works.` } : { ok: false, text: `The password was changed but the email to ${p.email} did not send. Press "Resend sign-in details" again.` });
    t.reload();
  }

  return (
    <Page className="team-approved" title="Team" sub={admin ? "Everyone in the workspace" : "People you can add to projects"}
      actions={<>{me.workload && <Link className="btn ghost" href="/workload">Workload</Link>}{me.orgRole === "SUPER_ADMIN" && <button className="btn" onClick={() => setAdding(true)}>+ Add person</button>}</>}>
      {err && <div className="err" role="alert">{err}</div>}
      {note && <div className={note.ok ? "ok" : "err"} role="status">{note.text} <button className="btn ghost sm" onClick={() => setNote(null)}>Close</button></div>}
      {t.loading && <Skeleton />}
      {t.error && <div className="err" role="alert">{t.error}</div>}
      {t.data && !admin && (
        <div className="list">{people.map((p) => (
          <div className="item" key={p.id}>
            <span className="av sm">{p.name[0]}</span>
            <div className="t"><b><Link href={`/team/${p.id}`} prefetch={false}>{p.name}</Link>{p.id === me.id && " (you)"}</b></div>
            {p.orgRole && <span className={`chip${p.orgRole === "MEMBER" ? " grey" : ""}`}>{roleLabel(p.orgRole)}</span>}
            <Leads p={p} />
          </div>
        ))}</div>
      )}
      {t.data && admin && (
        <div className="scroll">
          <table className="tbl stack">
            <colgroup><col className="team-col-person" /><col className="team-col-role" /><col className="team-col-leads" /><col className="team-col-status" /><col className="team-col-actions" /></colgroup>
            <thead><tr><th>Person</th><th>Workspace role</th><th>Leads</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {people.map((p) => {
                const [sl, sc] = STATUS[p.status ?? "ACTIVE"];
                const self = p.id === me.id;
                return (
                  <tr key={p.id}>
                    <td data-label="Person"><div className="team-identity"><b style={{ fontWeight: 500 }}><Link href={`/team/${p.id}`} prefetch={false}>{p.name}</Link>{self && " (you)"}</b><small className="team-email">{p.email}</small></div></td>
                    <td data-label="Workspace role"><span>{roleLabel(p.orgRole!)}</span></td>
                    <td data-label="Leads"><Leads p={p} /></td>
                    <td data-label="Status"><span className={`team-status ${sc}`}>{sl}</span></td>
                    <td data-label="Actions">
                      {((p.status === "ACTIVE" && p.orgRole !== "SUPER_ADMIN") || (me.orgRole === "SUPER_ADMIN" && !self && p.status !== "DEACTIVATED") || p.status === "DEACTIVATED") ? <details className="team-more" onKeyDown={e => { if (e.key === "Escape") { e.currentTarget.open = false; e.currentTarget.querySelector("summary")?.focus(); } }}><summary className="btn ghost" aria-label={`More actions for ${p.name}`}>More</summary><div className="team-more-actions">
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
                        {me.orgRole === "SUPER_ADMIN" && !self && p.status !== "DEACTIVATED" && (
                          <button className="btn ghost sm" onClick={() => resend(p)}>Resend sign-in details</button>
                        )}
                        {p.status === "DEACTIVATED" && <button className="btn ghost sm" onClick={() => act(p, "reactivate")}>Reactivate</button>}
                      </div></details> : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {adding && <AddPerson onClose={() => setAdding(false)} onAdded={(r) => { setAdding(false); setErr(null); setNote(r.emailSent ? { ok: true, text: `${r.name} was added. Sign-in details were emailed to ${r.email}.` } : { ok: false, text: `${r.name} was added, but the email to ${r.email} did not send. Press "Resend sign-in details" on their row.` }); t.reload(); }} />}
      {deact && <Deactivate p={deact} others={active.filter((x) => x.id !== deact.id)} onClose={() => setDeact(null)} onDone={(r) => { setDone({ name: deact.name, moved: r.moved, fellBack: r.fellBack }); setDeact(null); t.reload(); }} />}
      {done && (
        <Confirm title={`${done.name} is deactivated`} yes="Close" onNo={() => setDone(null)} onYes={() => setDone(null)}
          body={`${done.moved} open task${done.moved === 1 ? " was" : "s were"} handed over.`}>
          {done.fellBack.length > 0 && <p className="hint">{fellBackHint(done.fellBack)}</p>}
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
            {others.map((o) => <option key={o.id} value={o.id}>{personText(o)}</option>)}
          </select>
        )}
      </Field>
      <p className="hint">{FALLBACK_HINT}</p>
      {leads.length > 0 && (
        <div className="box warn">
          <b>{p.name} leads {leads.length === 1 ? "a project" : "projects"}.</b> Hand over the leadership first, then deactivate:
          <ul>{leads.map((l) => <li key={l.id}><Link href={`/projects/${l.id}/members`}>{l.name}: Change leader</Link></li>)}</ul>
        </div>
      )}
    </Confirm>
  );
}

function AddPerson({ onClose, onAdded }: { onClose: () => void; onAdded: (r: { name: string; email: string; emailSent: boolean }) => void }) {
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"MEMBER" | "ADMIN">("MEMBER");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const r = await api<{ person: { name: string; email: string; emailSent: boolean } }>("POST", "/api/team", { firstName: first, lastName: last, email, role });
    setBusy(false);
    if (r.ok) onAdded(r.data.person);
    else setErr(r.error ?? "Could not add this person.");
  }
  return (
    <Modal small label="Add person" onClose={onClose}>
      <form onSubmit={submit}>
        <h2>Add person</h2>
        <p className="hint">They get an email with their username and a password.</p>
        <Field label="First name">{(id) => <input id={id} className="in" value={first} onChange={(e) => setFirst(e.target.value)} autoComplete="off" required />}</Field>
        <Field label="Last name">{(id) => <input id={id} className="in" value={last} onChange={(e) => setLast(e.target.value)} autoComplete="off" required />}</Field>
        <Field label="Email" hint="Any email address. The person can use it to sign in straight away.">{(id) => <input id={id} className="in" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />}</Field>
        <Field label="Role" hint="A Member works on projects they belong to. An Admin also manages people and projects.">
          {(id) => (
            <select id={id} className="in" value={role} onChange={(e) => setRole(e.target.value as "MEMBER" | "ADMIN")}>
              <option value="MEMBER">Member</option>
              <option value="ADMIN">Admin</option>
            </select>
          )}
        </Field>
        <p className="hint">The password is made at random and you will not see it. The person must replace it with their own when they first sign in.</p>
        {err && <div className="err" role="alert">{err}</div>}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy || !first.trim() || !last.trim() || !email.trim()}>Add and email</button>
        </div>
      </form>
    </Modal>
  );
}
