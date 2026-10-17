"use client";
// SHO-US-11.4: the Links section of a task. Editors add and remove; Viewers only read.
import Link from "next/link";
import { useState } from "react";
import { api, useGet } from "@/components/api";

type L = { id: string; organisation: { id: string; name: string } | null; contact: { id: string; name: string; organisationId: string } | null };

export function TaskLinks({ taskId, links, canEdit, onChanged }: { taskId: string; links: L[]; canEdit: boolean; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [org, setOrg] = useState("");
  const [contact, setContact] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const orgs = useGet<{ organisations: { id: string; name: string }[] }>(adding ? "/api/orgs" : null);
  const contacts = useGet<{ contacts: { id: string; name: string }[] }>(adding && org ? `/api/orgs/${org}/contacts` : null);
  async function add() {
    const r = await api("POST", `/api/tasks/${taskId}/links`, contact ? { contactId: contact } : { organisationId: org });
    if (r.ok) { setAdding(false); setOrg(""); setContact(""); setErr(null); onChanged(); } else setErr(r.error ?? "Could not link.");
  }
  async function remove(id: string) { const r = await api("DELETE", `/api/tasks/${taskId}/links/${id}`); if (r.ok) onChanged(); else setErr(r.error ?? "Could not remove the link."); }
  if (!canEdit && links.length === 0) return null;
  return (
    <div className="box" style={{ fontSize: 14 }}>
      <b>Links</b>{" "}
      {links.length === 0 && <span style={{ color: "var(--muted)" }}>None yet.</span>}
      {links.map((l) => (
        <span key={l.id} className="chip" style={{ marginRight: 4 }}>
          {l.contact ? <Link href={`/accounts/${l.contact.organisationId}`}>{l.contact.name}</Link> : <Link href={`/accounts/${l.organisation!.id}`}>{l.organisation!.name}</Link>}
          {canEdit && <button className="link" aria-label="Remove link" style={{ marginLeft: 4 }} onClick={() => remove(l.id)}>×</button>}
        </span>
      ))}
      {canEdit && !adding && <button className="btn ghost sm" onClick={() => setAdding(true)}>+ Link</button>}
      {adding && (
        <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          <select className="in" aria-label="Organisation" value={org} onChange={(e) => { setOrg(e.target.value); setContact(""); }}><option value="">Organisation</option>{orgs.data?.organisations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
          {org && <select className="in" aria-label="Contact" value={contact} onChange={(e) => setContact(e.target.value)}><option value="">Whole organisation</option>{contacts.data?.contacts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
          <button className="btn sm" disabled={!org} onClick={add}>Link</button><button className="btn ghost sm" onClick={() => setAdding(false)}>Cancel</button>
        </span>
      )}
      {err && <div className="err" role="alert">{err}</div>}
    </div>
  );
}
