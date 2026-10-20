"use client";
import Link from "next/link";
import { useState } from "react";
import { api, useGet } from "@/components/api";
import { Field, Modal, Skeleton } from "@/components/ui";
import { Page } from "../Shell";
import "./scroll.css";

type O = { id: string; name: string; kind: string | null; country: string | null; parent: { id: string; name: string } | null; openDeals: number };

function NewOrg({ onClose, onDone }: { onClose: () => void; onDone: (id: string) => void }) {
  const all = useGet<{ organisations: O[] }>("/api/orgs");
  const [v, setV] = useState({ name: "", kind: "", country: "", parentId: "" });
  const [err, setErr] = useState<string | null>(null);
  const [dup, setDup] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  async function save(force = false) {
    const r = await api("POST", "/api/orgs", { name: v.name, kind: v.kind || null, country: v.country || null, parentId: v.parentId || null, force });
    if (r.ok) onDone(r.data.organisation.id);
    else { setDup(r.data?.needsConfirm === "duplicate"); setErr(r.error ?? "Could not save."); }
  }
  return (
    <Modal onClose={onClose} label="New organisation">
      <h2>New organisation</h2>
      <Field label="Name">{(id) => <input id={id} className="in" value={v.name} onChange={set("name")} />}</Field>
      <Field label="Kind (e.g. Ministry, Company)">{(id) => <input id={id} className="in" value={v.kind} onChange={set("kind")} />}</Field>
      <Field label="Country">{(id) => <input id={id} className="in" value={v.country} onChange={set("country")} />}</Field>
      <Field label="Sits under (optional)">{(id) => <select id={id} className="in" value={v.parentId} onChange={set("parentId")}><option value="">Top level</option>{all.data?.organisations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}</Field>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        {dup && <button className="btn ghost" onClick={() => save(true)}>Add anyway</button>}
        <button className="btn" disabled={!v.name.trim()} onClick={() => save()}>Add</button>
      </div>
    </Modal>
  );
}

export default function AccountsView({ initialQuery = "", initialKind = "" }: { initialQuery?: string; initialKind?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [kind, setKind] = useState(initialKind);
  const [adding, setAdding] = useState(false);
  const qs = [q ? `q=${encodeURIComponent(q)}` : "", kind ? `kind=${encodeURIComponent(kind)}` : ""].filter(Boolean).join("&");
  const { data, loading, error, reload } = useGet<{ organisations: O[] }>(`/api/orgs${qs ? `?${qs}` : ""}`);
  const kinds = useGet<{ organisations: O[] }>("/api/orgs");
  const rows = data?.organisations ?? [];
  return (
    <Page title="Accounts" sub="Organisations you can start deals with" actions={<button className="btn" onClick={() => setAdding(true)}>+ New organisation</button>}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12, minWidth: 0 }}>
        <input className="in" style={{ maxWidth: 360, minWidth: 0 }} placeholder="Search organisations" aria-label="Search organisations" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="in" style={{ maxWidth: 200, minWidth: 0 }} aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {[...new Set((kinds.data?.organisations ?? []).map((o) => o.kind).filter((k): k is string => !!k))].sort().map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </div>
      {loading && !data && <Skeleton />}
      {error && <div className="err" role="alert">{error}</div>}
      {data && rows.length === 0 && <div className="card empty"><b>No organisations found.</b></div>}
      {rows.length > 0 && (
        <div className="acct-scroll" tabIndex={0} role="region" aria-label="Accounts">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Kind</th><th>Country</th><th>Under</th><th>Open deals</th></tr></thead>
            <tbody>{rows.map((o) => (
              <tr key={o.id}><td><Link href={`/accounts/${o.id}`}>{o.name}</Link></td><td>{o.kind ?? "—"}</td><td>{o.country ?? "—"}</td><td>{o.parent?.name ?? "—"}</td><td>{o.openDeals}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {adding && <NewOrg onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
    </Page>
  );
}
