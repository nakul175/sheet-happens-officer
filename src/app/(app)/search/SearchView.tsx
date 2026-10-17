"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useGet } from "@/components/api";
import { Page } from "../Shell";

type Res = {
  projects: { id: string; name: string; archived: boolean }[];
  tasks: { id: string; title: string; done: boolean; assignee: string; project: { id: string; name: string }; archived: boolean }[];
};

export default function SearchView() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [archived, setArchived] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const r = useGet<Res>(debounced.length >= 2 ? `/api/search?q=${encodeURIComponent(debounced)}${archived ? "&archived=true" : ""}` : null);
  const none = r.data && !r.data.projects.length && !r.data.tasks.length;
  return (
    <Page title="Search" sub="Projects and tasks you can see">
      <div className="card" style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <input className="in" style={{ flex: 1, minWidth: 220 }} type="search" autoFocus placeholder="Search projects and tasks" aria-label="Search" value={q} onChange={(e) => setQ(e.target.value)} />
        <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Include archived
        </label>
      </div>
      {debounced.length < 2 && <div className="card empty">Type at least two letters.</div>}
      {r.error && <div className="err" role="alert">{r.error}</div>}
      {none && <div className="card empty">Nothing matches &ldquo;{debounced}&rdquo;{archived ? "" : ". Archived projects are left out unless you tick Include archived"}.</div>}
      {!!r.data?.projects.length && (
        <>
          <div className="grp">Projects</div>
          <div className="list">
            {r.data.projects.map((p) => (
              <Link key={p.id} href={`/projects/${p.id}`} className="item"><div className="t"><b>{p.name}</b></div>{p.archived && <span className="chip grey">Archived</span>}</Link>
            ))}
          </div>
        </>
      )}
      {!!r.data?.tasks.length && (
        <>
          <div className="grp">Tasks</div>
          <div className="list">
            {r.data.tasks.map((t) => (
              <Link key={t.id} href={`/projects/${t.project.id}?task=${t.id}`} className="item">
                <div className="t"><b>{t.title}</b><small>{t.project.name} · {t.assignee}</small></div>
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
