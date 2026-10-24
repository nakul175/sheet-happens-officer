"use client";
import Link from "next/link";
import { useState } from "react";
import { useGet } from "@/components/api";
import { Skeleton } from "@/components/ui";
import { Page } from "../Shell";
import "./scroll.css";
import OrgDialog from "./OrgDialog";

type O = { id: string; name: string; kind: string | null; country: string | null; parent: { id: string; name: string } | null; openDeals: number };

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
      {adding && <OrgDialog onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
    </Page>
  );
}
