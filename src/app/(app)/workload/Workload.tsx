"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { dueState, useGet } from "@/components/api";
import { Pri } from "@/components/TaskParts";
import { TaskModal } from "@/components/TaskModal";
import { LoadFailed, Skeleton } from "@/components/ui";
import type { WorkloadMetric, WorkloadPerson } from "@/lib/workload";
import { workloadHref, workloadMetric, workloadQuery } from "@/lib/workload-query";
import { openTaskSheet } from "@/lib/task-sheet-history";
import { Page, useMe } from "../Shell";
import "./workload.css";

type Summary = { items: WorkloadPerson[]; dueWindow: { from: string; through: string } };
type TaskRow = { id: string; title: string; parentId: string | null; dueDate: string | null; priority: string; blocked: boolean; project: { id: string; name: string } };
type Tasks = { person: { id: string; name: string }; metric: WorkloadMetric; total: number; items: TaskRow[]; nextCursor: string | null };
export const WORKLOAD_LABELS: Record<WorkloadMetric, string> = { open: "Open tasks", due: "Next 7 days", overdue: "Overdue", approval: "Awaiting approval", blocked: "Blocked" };
const metrics = Object.keys(WORKLOAD_LABELS) as WorkloadMetric[];

export default function Workload() {
  const me = useMe();
  const sp = useSearchParams(), router = useRouter();
  const parsed = workloadQuery.safeParse(Object.fromEntries(sp));
  const selected = parsed.success ? parsed.data : null;
  const metric = workloadMetric(selected ?? {});
  const query = new URLSearchParams();
  if (selected) for (const [key, value] of Object.entries(selected)) if (value) query.set(key, value);
  const summary = useGet<Summary>("/api/workload");
  const tasks = useGet<Tasks>(selected?.assignee ? `/api/workload?${query}` : null);
  const { reload: reloadSummary } = summary, { reload: reloadTasks } = tasks;
  useEffect(() => {
    const undone = (event: Event) => { event.preventDefault(); reloadSummary(); reloadTasks(); };
    window.addEventListener("sho:undone", undone);
    return () => window.removeEventListener("sho:undone", undone);
  }, [reloadSummary, reloadTasks]);
  const modalHref = (task?: string) => {
    const q = new URLSearchParams(sp.toString());
    q.delete("task"); if (task) q.set("task", task);
    return `/workload${q.size ? `?${q}` : ""}`;
  };
  const activePerson = summary.data?.items.find(p => p.id === selected?.assignee);
  const names = new Map<string, number>();
  for (const p of summary.data?.items ?? []) names.set(p.name.trim().toLowerCase(), (names.get(p.name.trim().toLowerCase()) ?? 0) + 1);
  const duplicateName = (p: WorkloadPerson) => (names.get(p.name.trim().toLowerCase()) ?? 0) > 1;
  const firstPage = selected?.assignee ? workloadHref(selected.assignee, metric) : "/workload";
  const next = new URLSearchParams(query);
  if (tasks.data?.nextCursor) next.set("cursor", tasks.data.nextCursor);
  const unavailable = summary.status === 403 || summary.status === 404;
  return <Page className="workload-page" title="Workload" sub="See who needs support, then open their tasks to rebalance work."
    beforeTitle={<nav aria-label="Breadcrumb"><Link href="/team">Team</Link> / Workload</nav>}
    actions={<Link className="btn ghost" href="/team">Back to Team</Link>}>
    {unavailable ? <div className="card empty">Workload isn&apos;t available for your account.</div> : <>
      {summary.loading && !summary.data && <Skeleton />}
      {summary.failed && <LoadFailed onRetry={summary.reload} />}
      {summary.data && <section className="workload-panel" aria-labelledby="workload-people-title">
        <div className="workload-section-head"><div><h2 id="workload-people-title">People</h2><p>Sorted by overdue tasks, then open tasks.</p></div>
          <span className="hint">Next 7 days: {summary.data.dueWindow.from} – {summary.data.dueWindow.through} · IST</span></div>
        <table className="workload-table"><caption className="sr-only">Workload by person. Select a count to open its tasks.</caption>
          <thead><tr><th scope="col">Person</th>{metrics.map(m => <th key={m} scope="col">{WORKLOAD_LABELS[m]}</th>)}</tr></thead>
          <tbody>{summary.data.items.map(p => <tr key={p.id} className={p.id === selected?.assignee ? "workload-selected" : undefined}>
            <th scope="row">{p.name}{duplicateName(p) && p.email && <small className="workload-person-email">{p.email}</small>}</th>{metrics.map(m => <td key={m}>
              <span className="workload-mobile-label" aria-hidden="true">{WORKLOAD_LABELS[m]}</span>
              <Link className={`workload-count${m === "overdue" && p[m] > 0 ? " workload-overdue" : ""}`}
                href={`${workloadHref(p.id, m)}#workload-tasks`} aria-label={`${p.name}${duplicateName(p) && p.email ? ` (${p.email})` : ""}: ${p[m]} ${WORKLOAD_LABELS[m].toLowerCase()}`}
                aria-current={p.id === selected?.assignee && m === metric ? "page" : undefined}>{p[m]}</Link>
            </td>)}</tr>)}</tbody>
        </table>
        {!summary.data.items.length && <p className="empty">No people in this scope.</p>}
      </section>}
      {!parsed.success && <div className="box warn" role="alert">This workload filter isn&apos;t valid. <Link href="/workload">Clear filters</Link></div>}
      {selected?.assignee && <section className="workload-panel" id="workload-tasks" aria-labelledby="workload-tasks-title">
        <div className="workload-section-head"><h2 id="workload-tasks-title">{WORKLOAD_LABELS[metric]}{activePerson ? ` · ${activePerson.name}` : ""}</h2><Link href="/workload">Clear selection</Link></div>
        {activePerson && <nav className="workload-metrics" aria-label="Task count"><>{metrics.map(m => <Link key={m} href={`${workloadHref(activePerson.id, m)}#workload-tasks`} aria-current={metric === m ? "page" : undefined}>{WORKLOAD_LABELS[m]} <span>{activePerson[m]}</span></Link>)}</></nav>}
        {tasks.loading && <Skeleton />}
        {tasks.failed && <LoadFailed onRetry={tasks.reload} />}
        {(tasks.status === 403 || tasks.status === 404) && <p className="empty">This person or task list isn&apos;t available.</p>}
        {tasks.data && <>
          <p className="hint">{tasks.data.total} matching task{tasks.data.total === 1 ? "" : "s"}. Open a task to change its assignee.</p>
          {!tasks.data.items.length && <p className="empty">No tasks match this count.</p>}
          <ul className="workload-tasks">{tasks.data.items.map(t => <li key={t.id}>
            <div><button type="button" className="workload-task-title" onClick={() => { const href = modalHref(t.id); if (!openTaskSheet(href)) router.push(href, { scroll: false }); }}>{t.title}</button>
              <div className="workload-task-context">{t.parentId && <span>Subtask · </span>}<Link href={`/projects/${t.project.id}`}>{t.project.name}</Link></div></div>
            <div className="workload-task-meta"><Pri p={t.priority} /><span>{t.dueDate ? dueState(t.dueDate) : "No due date"}</span>{t.blocked && <span className="chip">Blocked</span>}</div>
          </li>)}</ul>
          {(selected.cursor || tasks.data.nextCursor) && <nav className="workload-pagination" aria-label="Task pages">
            {selected.cursor && <Link className="btn ghost" href={`${firstPage}#workload-tasks`}>First page</Link>}
            {tasks.data.nextCursor && <Link className="btn ghost" href={`/workload?${next}#workload-tasks`}>Next tasks</Link>}
          </nav>}
        </>}
      </section>}
    </>}
    {!unavailable && selected && sp.get("task") && <TaskModal id={sp.get("task")!} me={me.id} onClose={() => router.replace(modalHref(), { scroll: false })} onChanged={() => { reloadSummary(); reloadTasks(); }} />}
  </Page>;
}
