"use client";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { PRIORITY, api, dueLabel, isOverdue, todayIST, useGet } from "@/components/api";
import { TaskModal } from "@/components/TaskModal";
import { Tick } from "@/components/TaskParts";
import { Page, useMe } from "./Shell";

type Item = {
  id: string; title: string; dueDate: string | null; blocked: boolean; priority: string; canClose: boolean; relation: "ASSIGNEE" | "COLLABORATOR";
  project: { id: string; name: string; type?: "PROJECT" | "DEAL"; stage?: string | null }; parent: { id: string; title: string } | null; awaitingApproval: boolean; isIdea?: boolean;
};
type NeedsStep = { id: string; name: string; stage: string | null };
type Groups = { overdue: Item[]; next7: Item[]; later: Item[]; needsNextStep?: NeedsStep[] };

/** One dated task for a deal with no next step (SHO-US-12.5 AC2, AC3). */
function AddNext({ projectId, meId, label, onDone, onCancel }: { projectId: string; meId: string; label: string; onDone: () => void; onCancel?: () => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState(todayIST());
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    const r = await api("POST", `/api/projects/${projectId}/tasks`, { title, dueDate: due, assigneeId: meId });
    if (r.ok) { setOpen(false); setTitle(""); onDone(); } else setErr(r.error ?? "Could not add the task.");
  }
  if (!open) return <button className="btn sm" onClick={() => setOpen(true)}>{label}</button>;
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <input className="in" aria-label="Next task" placeholder="Next task" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className="in" aria-label="Due date" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
      <button className="btn sm" disabled={!title.trim() || !due} onClick={save}>Add</button>
      <button className="btn ghost sm" onClick={() => { setOpen(false); onCancel?.(); }}>Cancel</button>
      {err && <span className="err" role="alert" style={{ margin: 0 }}>{err}</span>}
    </span>
  );
}

const GROUP_KEY = (id: string) => `sho.home.group.${id}`;

function Inner() {
  const me = useMe();
  const { data, error, loading, reload } = useGet<Groups>("/api/my-tasks");
  const [mode, setMode] = useState<"date" | "project">("date");
  const [done, setDone] = useState<{ projectId: string; name: string; slot: string }[]>([]);
  const [dismissed, setDismissed] = useState<string[]>([]);
  // Reads the saved choice from browser storage after mount (reading it during render would not match the server HTML).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { try { if (localStorage.getItem(GROUP_KEY(me.id)) === "project") setMode("project"); } catch { /* storage blocked: stay By date */ } }, [me.id]);
  const pick = (m: "date" | "project") => { setMode(m); try { localStorage.setItem(GROUP_KEY(me.id), m); } catch { /* ignore */ } };
  const router = useRouter();
  const open = useSearchParams().get("task");
  const total = data ? data.overdue.length + data.next7.length + data.later.length : 0;
  const groups: ("overdue" | "next7" | "later")[] = ["overdue", "next7", "later"];
  const labels = { overdue: "Overdue", next7: "Next 7 days", later: "Later" };
  const all = data ? [...data.overdue, ...data.next7, ...data.later] : [];
  const needs = data?.needsNextStep ?? [];
  const byProject = (() => {
    const m = new Map<string, { project: Item["project"]; items: Item[] }>();
    for (const t of all) { const e = m.get(t.project.id) ?? { project: t.project, items: [] }; e.items.push(t); m.set(t.project.id, e); }
    for (const n of needs) if (!m.has(n.id)) m.set(n.id, { project: { id: n.id, name: n.name, type: "DEAL", stage: n.stage }, items: [] });
    const key = (e: { items: Item[] }) => e.items.map((i) => i.dueDate ?? "9999").sort()[0] ?? "9999";
    return [...m.values()].sort((a, b) => key(a).localeCompare(key(b)));
  })();
  const prompts = done.filter((d) => needs.some((n) => n.id === d.projectId) && !dismissed.includes(d.projectId));
  // The prompt sits where the finished task was: in its date group, or under its project heading.
  const promptsAt = (slot: string) => prompts.filter((p) => p.slot === slot);
  const promptCard = (p: { projectId: string; name: string }) => (
    <div key={p.projectId} className="card" style={{ marginBottom: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <b>What is next for {p.name}?</b>
      <AddNext projectId={p.projectId} meId={me.id} label="+ Next task" onDone={reload} />
      <button className="btn ghost sm" onClick={() => setDismissed((d) => [...d, p.projectId])}>Not now</button>
    </div>
  );
  const slotOf = (t: Item) => (mode === "project" && me.crm ? t.project.id : groups.find((g) => data?.[g].some((x) => x.id === t.id)) ?? "later");
  const row = (t: Item) => (
    <div key={t.id} className="item click" onClick={() => router.push(`/?task=${t.id}`, { scroll: false })}>
      <Tick id={t.id} title={t.title} done={false} allowed={t.canClose} onDone={() => { if (t.project.type === "DEAL") setDone((d) => [...d, { projectId: t.project.id, name: t.project.name, slot: slotOf(t) }]); reload(); }} />
      <div className="t">
        <b><a href={`/tasks/${t.id}`} style={{ color: "inherit", textDecoration: "none" }} onClick={(e) => { e.preventDefault(); }}>{t.title}</a></b>
        <small>{t.parent ? `Subtask of ${t.parent.title} · ` : ""}{t.project.name}</small>
      </div>
      <div className="meta">
        {t.isIdea && <span className="chip gold">Idea</span>}
        {t.relation === "COLLABORATOR" && <span className="chip grey">Collaborator</span>}
        {t.awaitingApproval && <span className="chip gold">Awaiting approval</span>}
        {t.blocked && <span className="chip red">Blocked</span>}
        <span className={`pri-${t.priority}`}>{PRIORITY[t.priority]}</span>
        <span className={isOverdue(t.dueDate) ? "over" : undefined}>{dueLabel(t.dueDate)}</span>
      </div>
    </div>
  );
  return (
    <Page dock title="My tasks" sub={data ? `${total} open task${total === 1 ? "" : "s"} assigned to you or shared with you` : " "}
      actions={me.crm && (
        <div className="seg" role="group" aria-label="Group tasks">
          <button aria-pressed={mode === "date"} onClick={() => pick("date")}>By date</button>
          <button aria-pressed={mode === "project"} onClick={() => pick("project")}>By project</button>
        </div>
      )}>
      {loading && !data && <div className="skel">Loading…</div>}
      {error && <div className="err" role="alert">{error}</div>}
      {data && total === 0 && needs.length === 0 && (
        <div className="card empty"><b>Nothing on your plate.</b><br />Tasks assigned to you, or that you collaborate on, show up here.</div>
      )}
      {data && (!me.crm || mode === "date") && groups.map((key) => (data[key].length > 0 || promptsAt(key).length > 0) && (
        <section key={key} aria-label={labels[key]}>
          <div className={`grp${key === "overdue" ? " red" : ""}`}>{labels[key]} · {data[key].length}</div>
          {promptsAt(key).map(promptCard)}
          <div className="list">{data[key].map(row)}</div>
        </section>
      ))}
      {data && me.crm && mode === "project" && byProject.map((g) => (
        <section key={g.project.id} aria-label={g.project.name}>
          <div className="grp">
            <Link href={`/projects/${g.project.id}`} style={{ color: "inherit" }}>{g.project.name}</Link>
            {g.project.type === "DEAL" && <> <span className="chip">Deal</span>{g.project.stage && <> <span className="chip grey">{g.project.stage}</span></>}</>}
          </div>
          {promptsAt(g.project.id).map(promptCard)}
          {g.items.length > 0 && <div className="list">{g.items.map(row)}</div>}
          {needs.some((n) => n.id === g.project.id) && (
            <div className="card" style={{ marginTop: 6, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span className="chip red">Needs a next step</span>
              <AddNext projectId={g.project.id} meId={me.id} label="+ Add task" onDone={reload} />
            </div>
          )}
        </section>
      ))}
      {data && (!me.crm || mode === "date") && needs.length > 0 && (
        <section aria-label="Deals that need a next step">
          <div className="grp red">Deals that need a next step · {needs.length}</div>
          {needs.map((n) => (
            <div key={n.id} className="card" style={{ marginBottom: 6, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <Link href={`/projects/${n.id}`}><b>{n.name}</b></Link> <span className="chip grey">{n.stage}</span>
              <AddNext projectId={n.id} meId={me.id} label="+ Add task" onDone={reload} />
            </div>
          ))}
        </section>
      )}
      {open && <TaskModal id={open} me={me.id} onClose={() => router.push("/", { scroll: false })} onChanged={reload} />}
    </Page>
  );
}
export default function MyTasks() { return <Suspense><Inner /></Suspense>; }
