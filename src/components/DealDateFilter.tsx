"use client";
import { useState } from "react";
import { DEAL_DATE_BASES, parseDealDateFilter, type DealDateFilter as DateFilter } from "@/lib/deal-date-filter";
export function DealDateFilter({ value, onChange }: { value?: DateFilter; onChange: (value: DateFilter | undefined) => void }) {
  const [basis, setBasis] = useState(value?.basis ?? "");
  const [from, setFrom] = useState(value?.from ?? "");
  const [to, setTo] = useState(value?.to ?? "");
  const [includeUndated, setIncludeUndated] = useState(value?.includeUndated ?? false);
  const [error, setError] = useState<string | null>(null);
  const clear = () => { setBasis(""); setFrom(""); setTo(""); setIncludeUndated(false); setError(null); onChange(undefined); };
  return <section className="card" aria-label="Deal date filter" style={{ marginBottom: 12 }}>
    <form onSubmit={event => { event.preventDefault(); try { const parsed = parseDealDateFilter({ basis, from, to, includeUndated }); onChange(parsed); setError(null); } catch (error) { setError(error instanceof Error ? error.message : "Check the date range."); } }}>
      <div className="pills" style={{ alignItems: "end" }}>
        <label>Date basis<select className="in" aria-label="Date basis" value={basis} onChange={event => { setBasis(event.target.value); if (!event.target.value) { setFrom(""); setTo(""); setIncludeUndated(false); } }}><option value="">No date filter</option>{DEAL_DATE_BASES.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label>From date (IST, inclusive)<input className="in" aria-label="From date (IST, inclusive)" type="date" disabled={!basis} value={from} onChange={event => setFrom(event.target.value)} /></label>
        <label>To date (IST, inclusive)<input className="in" aria-label="To date (IST, inclusive)" type="date" disabled={!basis} value={to} onChange={event => setTo(event.target.value)} /></label>
        <label className="pills"><input type="checkbox" checked={includeUndated} disabled={!basis} onChange={event => setIncludeUndated(event.target.checked)} /> Include undated deals</label>
        <button className="btn ghost" type="submit">Apply date filter</button><button className="btn ghost" type="button" onClick={clear}>Clear date filter</button>
      </div>
      {error && <p className="err" role="alert">{error}</p>}
    </form>
    <p className="hint" role="status">{value ? `${DEAL_DATE_BASES.find(option => option.value === value.basis)!.label} · ${value.from ? `from ${value.from}` : "any start date"} ${value.to ? `through ${value.to}` : "onwards"} · IST (UTC+05:30), inclusive calendar dates · ${value.includeUndated ? "Undated included" : "Undated excluded"}.` : "No date filter. All dates and undated deals are included."}</p>
    <p className="hint">Applies to this Deals view and its counts. Created date is always present. Date-only deadlines retain their calendar date; timed deadlines use their IST calendar date.</p>
  </section>;
}
