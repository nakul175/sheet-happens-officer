"use client";
import { useId, useState } from "react";
import { api } from "@/components/api";
import { BuyerAccountPicker } from "@/components/BuyerAccountPicker";
import { Modal } from "@/components/ui";

export function ChangeDealBuyer({ projectId, buyer, onClose, onDone }: {
  projectId: string; buyer: { id: string; name: string }; onClose: () => void; onDone: () => void;
}) {
  const formId = useId();
  const [creatingBuyer, setCreatingBuyer] = useState(false);
  const [selection, setSelection] = useState(buyer);
  const organisationId = selection.id;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || creatingBuyer || !organisationId || organisationId === buyer.id) return;
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
      <BuyerAccountPicker value={selection} onChange={setSelection} disabled={busy} onBusyChange={setCreatingBuyer} />
      {error && <div className="err" role="alert">{error}</div>}
    </form>
    <div className="actions"><button className="btn ghost" type="button" disabled={busy || creatingBuyer} onClick={onClose}>Cancel</button><button className="btn" form={formId} disabled={busy || creatingBuyer || !organisationId || organisationId === buyer.id}>{busy ? "Saving…" : "Save Buyer"}</button></div>
  </Modal>;
}
