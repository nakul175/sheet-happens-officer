"use client";
import { finePointer } from "@/components/client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useGet } from "@/components/api";
import { Page, useMe } from "../Shell";

type Res = {
  organisations?: { id: string; name: string; kind: string | null }[];
  contacts?: { id: string; name: string; organisation: { id: string; name: string } }[];
  projects: { id: string; name: string; archived: boolean }[];
  tasks: { id: string; title: string; done: boolean; assignee: string; isIdea?: boolean; project: { id: string; name: string }; archived: boolean }[];
};

export default function SearchView() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const me = useMe();
  const [archived, setArchived] = useState(false);
  const [ideas, setIdeas] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const path = debounced.length >= 2 ? `/api/search?q=${encodeURIComponent(debounced)}${archived ? "&archived=true" : ""}${ideas ? "&idea=true" : ""}` : null;
  // A new query must not blank the list: there is no separate loading state on this screen.
  const r = useGet<Res>(path, { keepPrevious: true });
  const none = r.data && !r.data.projects.length && !r.data.tasks.length && !r.data.organisations?.length && !r.data.contacts?.length;
  return (
    <Page title="Search" sub="Projects and tasks you can see">
      <div className="card" style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <input className="in" style={{ flex: 1, minWidth: 220 }} type="search" autoFocus={finePointer()} placeholder="Search projects and tasks" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Include archived
        </label>
        {me.crm && (
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" checked={ideas} onChange={(e) => setIdeas(e.target.checked)} /> Ideas only
          </label>
        )}
      </div>
      {debounced.length < 2 && <div className="card empty" role="status">Type at least two letters.</div>}
      {r.error && <div className="err" role="alert">{r.error}</div>}
      {none && <div className="card empty" role="status">Nothing matches &ldquo;{debounced}&rdquo;{archived ? "" : ". Archived projects are left out unless you tick Include archived"}.</div>}
      {!!r.data?.organisations?.length && (
        <>
          <div className="grp" role="heading" aria-level={2}>Organisations</div>
          <div className="list">{r.data.organisations.map((o) => <Link key={o.id} href={`/accounts/${o.id}`} className="item"><div className="t"><b>{o.name}</b>{o.kind && <small>{o.kind}</small>}</div></Link>)}</div>
        </>
      )}
      {!!r.data?.contacts?.length && (
        <>
          <div className="grp" role="heading" aria-level={2}>Contacts</div>
          <div className="list">{r.data.contacts.map((c) => <Link key={c.id} href={`/accounts/${c.organisation.id}`} className="item"><div className="t"><b>{c.name}</b><small>{c.organisation.name}</small></div></Link>)}</div>
        </>
      )}
      {!!r.data?.projects.length && (
        <>
          <div className="grp" role="heading" aria-level={2}>Projects</div>
          <div className="list">
            {r.data.projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`} className="item"><div className="t"><b>{p.name}</b></div>{p.archived && <span className="chip grey">Archived</span>}</Link>
            ))}
          </div>
        </>
      )}
      {!!r.data?.tasks.length && (
        <>
          <div className="grp" role="heading" aria-level={2}>Tasks</div>
          <div className="list">
            {r.data.tasks.map((t) => (
              <Link key={t.id} href={`/projects/${t.project.id}?task=${t.id}`} className="item">
                <div className="t"><b>{t.title}</b><small>{t.project.name} · {t.assignee}</small></div>
                {t.isIdea && <span className="chip gold">Idea</span>}
                {t.done && <span className="chip green">Done</span>}
                {t.archived && <span className="chip grey">Archived</span>}
              </Link>
            ))}
          </div>
        </>
      )}
    </Page>
  );
}
