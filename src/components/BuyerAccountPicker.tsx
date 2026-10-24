"use client";
import { useRef, useState } from "react";
import { api, useGet } from "@/components/api";
import { ORGANISATION_KINDS } from "@/lib/org-kinds";
import { Field } from "@/components/ui";
type Account = { id: string; name: string };
/** Account creation is an explicit, independent save. Cancelling a deal never deletes an Account. */
export function BuyerAccountPicker({ value, onChange, disabled = false, onBusyChange, captureKind = false }: {
  value: Account | null; onChange: (account: Account) => void; disabled?: boolean; onBusyChange?: (busy: boolean) => void; captureKind?: boolean;
}) {
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const accounts = useGet<{ organisations: Account[] }>(`/api/orgs${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Account | null>(null), [match, setMatch] = useState<Account | null>(null);
  const inFlight = useRef(false);
  const options = accounts.data?.organisations ?? [];
  const exact = options.find(o => o.name.toLocaleLowerCase() === query.trim().toLocaleLowerCase());
  async function create() {
    if (inFlight.current || disabled || !query.trim()) return;
    inFlight.current = true; setBusy(true); onBusyChange?.(true); setError(null); setMatch(null);
    try {
      const r = await api("POST", "/api/orgs", { name: query.trim(), ...(captureKind ? { kind: kind || null } : {}) });
      if (r.ok) { const account = r.data.organisation as Account; setCreated(account); onChange(account); }
      else {
        setError(r.error ?? "Could not create Account. Your entered name is retained.");
        if (r.data?.existingId && !r.data.existingArchived) setMatch({ id: r.data.existingId, name: r.data.existingName ?? query.trim() });
      }
    } catch { setError("Could not create Account. Your entered name is retained; search before retrying if the connection was lost."); }
    finally { inFlight.current = false; setBusy(false); onBusyChange?.(false); }
  }
  return <div>
    <Field label="Search accounts">{id => <input id={id} className="in" type="search" maxLength={200} value={query} disabled={disabled || busy} onChange={e => { setQuery(e.target.value); setMatch(null); setError(null); }} placeholder="Type a Buyer name" />}</Field>
    <Field label="Organisation (buyer)">{id => <select id={id} className="in" required value={value?.id ?? ""} disabled={disabled || busy || accounts.loading} onChange={e => { const account = options.find(o => o.id === e.target.value); if (account) onChange(account); }}>
      {!value && <option value="">Choose</option>}
      {value && !options.some(o => o.id === value.id) && <option value={value.id}>{value.name} (selected)</option>}
      {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>}</Field>
    {captureKind && query.trim() && !exact && <Field label="Kind (optional, new Account)">{id => <select id={id} className="in" value={kind} disabled={disabled || busy} onChange={e => setKind(e.target.value)}><option value="">Not specified</option>{ORGANISATION_KINDS.map(k => <option key={k}>{k}</option>)}</select>}</Field>}
    {query.trim() && (exact ? <button type="button" className="btn ghost sm" disabled={disabled || busy} onClick={() => onChange(exact)}>Use existing Account: {exact.name}</button> : <button type="button" className="btn ghost sm" disabled={disabled || busy || accounts.loading || !!accounts.error} onClick={create}>{busy ? "Creating…" : `Create Account “${query.trim()}”`}</button>)}
    <p className="sub">Creating an Account saves it immediately. It remains in Accounts if you cancel or the deal cannot be saved. Choose an existing match to avoid duplicates.</p>
    {created && <p role="status">Account “{created.name}” saved and selected. It remains available even if this deal is not saved.</p>}
    {match && <button type="button" className="btn ghost sm" disabled={disabled || busy} onClick={() => { onChange(match); setError(null); }}>Use existing Account: {match.name}</button>}
    {(error || accounts.error) && <div className="err" role="alert">{error || accounts.error}</div>}
  </div>;
}
