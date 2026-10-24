"use client";
import { useId, useState } from "react";
import { api, useGet } from "@/components/api";
import { Field, Modal } from "@/components/ui";

export function ChangeDealBuyer({ projectId, buyer, onClose, onDone }: {
  projectId: string; buyer: { id: string; name: string }; onClose: () => void; onDone: () => void;
}) {
  const formId = useId();
  const [query, setQuery] = useState("");
  const accounts = useGet<{ organisations: { id: string; name: string }[] }>(`/api/orgs${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`);
  const [selection, setSelection] = useState(buyer);
  const organisationId = selection.id;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = accounts.data?.organisations ?? [];
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !organisationId || organisationId === buyer.id) return;
    setBusy(true); setError(null);
    try {
      const r = await api("PATCH", `/api/projects/${projectId}/buyer`, { organisationId, expectedOrganisationId: buyer.id });
      if (r.ok) onDone(); else setError(r.error ?? "Could not change Buyer.");
    } catch { setError("Could not change Buyer. Please try again."); }
    finally { setBusy(false); }
  }
  return <Modal onClose={onClose} label="Change Buyer">
    <form id={formId} onSubmit={save}>
      <h2>Change Buyer</h2>
      <p>This changes the organisation linked as Buyer for this deal. Account details and other party roles stay unchanged.</p>
      <Field label="Search accounts">{(id) => <input id={id} className="in" type="search" maxLength={200} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search for an existing account" />}</Field>
      <Field label="Buyer organisation">{(id) => <select id={id} className="in" required value={organisationId} disabled={busy || accounts.loading} onChange={(e) => { const selected = options.find((o) => o.id === e.target.value); if (selected) setSelection(selected); setError(null); }}>
        {!options.some((o) => o.id === selection.id) && <option value={selection.id}>{selection.name}{selection.id === buyer.id ? " (current Buyer)" : " (selected)"}</option>}
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>}</Field>
      {accounts.error && <div className="err" role="alert">{accounts.error}</div>}
      {error && <div className="err" role="alert">{error}</div>}
    </form>
    <div className="actions"><button className="btn ghost" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="btn" form={formId} disabled={busy || accounts.loading || !!accounts.error || !organisationId || organisationId === buyer.id}>{busy ? "Saving…" : "Save Buyer"}</button></div>
  </Modal>;
}
