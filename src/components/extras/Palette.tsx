"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, useGet } from "@/components/api";
import { Modal } from "@/components/ui";
import type { SearchHit } from "@/lib/search-ranking";

type Hit = { id: string; title: string; done: boolean; assignee: string; project: { id: string; name: string }; archived: boolean };
type Found = { hits?: SearchHit[]; tasks: Hit[]; projects: { id: string; name: string; archived: boolean; type: string }[] };
export type Command = { id: string; label: string; hint?: string; words?: string; run: () => void };
type Row = { key: string; group: string; label: string; sub?: string; excerpt?: boolean; run: () => void };

/**
 * SHO-US-14.7. One box: tasks (with project and assignee), projects, people and actions.
 * Tasks and projects come from the same search the Search screen uses, so a project the person is not in never shows.
 */
export function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [response, setResponse] = useState<{ query: string; data: Found } | null>(null);
  const [at, setAt] = useState(0);
  const team = useGet<{ people: { id: string; name: string }[] }>("/api/team");
  const seq = useRef(0);
  const text = q.trim();
  const found = response?.query === text ? response.data : null;

  useEffect(() => {
    if (text.length < 2) return;
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      const r = await api<Found>("GET", `/api/search?q=${encodeURIComponent(text)}`);
      if (mine === seq.current && r.ok) setResponse({ query: text, data: r.data });
    }, 120);
    return () => clearTimeout(t);
  }, [text]);

  const go = (href: string) => { onClose(); router.push(href); };
  const rows = useMemo<Row[]>(() => {
    const low = text.toLowerCase();
    const out: Row[] = [];
    for (const c of commands) {
      if (!low || (c.label + " " + (c.words ?? "")).toLowerCase().includes(low)) out.push({ key: `c:${c.id}`, group: "Actions", label: c.label, sub: c.hint, run: () => { onClose(); c.run(); } });
    }
    if (text.length >= 2 && found) {
      if (found.hits) {
        for (const hit of found.hits) out.push({ key: `${hit.type}:${hit.id}`, group: hit.type.toLowerCase(), label: hit.title, sub: `${hit.matchedField}: ${hit.excerpt}`, excerpt: true, run: () => go(hit.href) });
      } else {
        for (const t of found.tasks.slice(0, 8)) out.push({ key: `t:${t.id}`, group: "Tasks", label: t.title, sub: `${t.project.name} · ${t.assignee}${t.done ? " · done" : ""}`, run: () => go(`/tasks/${t.id}`) });
        for (const p of found.projects.slice(0, 5)) out.push({ key: `p:${p.id}`, group: p.type === "DEAL" ? "Deals" : "Projects", label: p.name, sub: p.archived ? "Archived" : undefined, run: () => go(`/projects/${p.id}`) });
      }
    }
    if (text.length >= 2) {
      for (const x of (team.data?.people ?? []).filter((p) => p.name.toLowerCase().includes(low)).slice(0, 5)) out.push({ key: `u:${x.id}`, group: "People", label: x.name, sub: "Open Team", run: () => go("/team") });
    }
    return out;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, found, commands, team.data]);

  useEffect(() => { setAt(0); }, [text]); // eslint-disable-line react-hooks/set-state-in-effect
  const sel = Math.min(at, Math.max(0, rows.length - 1));
  useEffect(() => { document.getElementById(`pal-${sel}`)?.scrollIntoView?.({ block: "nearest" }); }, [sel, rows.length]);

  function key(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setAt(Math.min(rows.length - 1, sel + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setAt(Math.max(0, sel - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); rows[sel]?.run(); }
  }
  let last = "";
  return (
    <Modal small label="Search and commands" onClose={onClose}>
      <div className="pal" onKeyDown={key}>
        <input data-autofocus className="in pal-in" role="combobox" aria-expanded aria-controls="pal-list" aria-autocomplete="list" aria-activedescendant={rows.length ? `pal-${sel}` : undefined}
          aria-label="Search tasks, projects, people and actions" placeholder="Search tasks, projects, people, or type new…" autoComplete="off" maxLength={200} value={q} onChange={(e) => setQ(e.target.value)} />
        <div id="pal-list" role="listbox" aria-label="Results" className="pal-list">
          {rows.map((r, i) => {
            const head = r.group !== last ? (last = r.group) : null;
            return (
              <div key={r.key}>
                {head && <div className="pal-grp" role="presentation">{head}</div>}
                <div id={`pal-${i}`} role="option" aria-selected={i === sel} className={`pal-row${i === sel ? " on" : ""}`} onMouseMove={() => setAt(i)} onClick={r.run}>
                  <span className="pal-l">{r.label}</span>
                  {r.sub && <small style={r.excerpt ? { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } : undefined}>{r.sub}</small>}
                </div>
              </div>
            );
          })}
          {text.length >= 2 && found && !rows.length && <div className="pal-none" role="status">Nothing matches &ldquo;{text}&rdquo;.</div>}
          {text.length === 1 && !rows.length && <div className="pal-none" role="status">Type one more letter to search.</div>}
        </div>
        <div className="pal-foot" aria-hidden><span>↑↓ choose</span><span>Enter open</span><span>Esc close</span></div>
      </div>
    </Modal>
  );
}
