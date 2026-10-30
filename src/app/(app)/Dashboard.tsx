"use client";
import Link from "next/link";
import { useEffect } from "react";
import { ago, dueState, useGet } from "@/components/api";
import { LoadFailed, Skeleton } from "@/components/ui";
import { useExtras } from "@/components/extras/Extras";
import { Page } from "./Shell";
import "./dashboard.css";
export type TaskSummary = { id: string; title: string; dueDate: string | null; project: { id: string; name: string } };
type Approval = TaskSummary & { waitingDays: number | null; waitingSince: string | null };
type Tasks = { asOf: string; open: number; overdue: number; awaiting: number; priorities: TaskSummary[]; approvals: Approval[] };
type Projects = { asOf: string; total: number; items: { id: string; name: string; isVertical: boolean; total: number; completed: number; percent: number }[] };
type Activity = { asOf: string; items: { id: string; who: string; what: string; ts: string; when: string; project: { id: string; name: string }; via: string }[] };
export function waitingLabel(days: number | null) { return days === null ? "Awaiting review" : days === 0 ? "Waiting since today" : `Waiting ${days} day${days === 1 ? "" : "s"}`; }
export function useDashboardRefresh(reload: () => void) {
  useEffect(() => {
    const refresh = () => reload();
    window.addEventListener("focus", refresh);
    window.addEventListener("sho:task-added", refresh);
    window.addEventListener("sho:undone", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("sho:task-added", refresh); window.removeEventListener("sho:undone", refresh); };
  }, [reload]);
}
function Status({ loading, error, data, retry }: { loading: boolean; error: string | null; data: unknown; retry: () => void }) {
  if (loading && !data) return <Skeleton />;
  if (error) return <LoadFailed onRetry={retry} />;
  return null;
}
function SummaryIcon({ kind }: { kind: string }) {
  return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {kind === "tasks" ? <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="m8 9 1.5 1.5L12 8M14 9h2M8 15h8" /></>
      : kind === "overdue" ? <><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 4h.01" /></>
      : kind === "approval" ? <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>
      : <><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z" /><path d="M3 11h18" /></>}
  </svg>;
}
export default function Dashboard() {
  const tasks = useGet<Tasks>("/api/dashboard?panel=tasks");
  const projects = useGet<Projects>("/api/dashboard?panel=projects");
  const activity = useGet<Activity>("/api/dashboard?panel=activity");
  useDashboardRefresh(tasks.reload); useDashboardRefresh(projects.reload); useDashboardRefresh(activity.reload);
  const { canAdd, openAdd } = useExtras();
  const date = tasks.data ? new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", timeZone: "Asia/Kolkata" }).format(new Date(tasks.data.asOf)) : null;
  const kpis = [
    { label: "Open tasks", value: tasks.data?.open, href: "/my-tasks", icon: "tasks" },
    { label: "Overdue", value: tasks.data?.overdue, href: "/my-tasks?filter=overdue", icon: "overdue", danger: true },
    { label: "Awaiting your approval", value: tasks.data?.awaiting, href: "/approvals", icon: "approval" },
    { label: "Active projects", value: projects.data?.total, href: "/projects", icon: "projects" },
  ];
  return <Page className="dashboard-view" title="Your workspace" sub="A clear view of what needs your attention." actions={<>{canAdd && <button className="btn" onClick={openAdd}>+ New task</button>}<Link className="btn ghost" href="/projects/new">+ New project</Link></>}>
    {date && <p className="dashboard-date">{date}</p>}
    <div className="dashboard-kpis" aria-label="Your work summary">
      {kpis.map(k => <Link className={`dashboard-kpi${k.danger ? " danger" : ""}`} href={k.href} key={k.label}><span className="dashboard-kpi-icon" aria-hidden="true"><SummaryIcon kind={k.icon} /></span><div>{k.label}<strong>{k.value === undefined ? "—" : k.value}</strong></div></Link>)}
    </div>
    <p className="hint">Approval tasks also count as your open work and may be overdue. Active projects includes delivery projects and vertical boards you belong to.</p>
    <div className="dashboard-grid">
      <section className="dashboard-panel" aria-label="Your priorities"><header><h2>Your priorities</h2><Link href="/my-tasks">View all tasks →</Link></header>
        <Status {...tasks} retry={tasks.reload} />
        {tasks.data && (tasks.data.priorities.length ? tasks.data.priorities.map(t => <Link className="dashboard-row" href={`/tasks/${t.id}`} key={t.id}><div><strong>{t.title}</strong><small>{t.project.name}</small></div><span>{dueState(t.dueDate)}</span></Link>) : <p className="hint">No open work assigned to you or shared with you.</p>)}
      </section>
      <section className="dashboard-panel" aria-label="Needs your approval"><header><h2>Needs your approval</h2></header>
        <Status {...tasks} retry={tasks.reload} />
        {tasks.data && (tasks.data.approvals.length ? tasks.data.approvals.map(t => <Link className="dashboard-row" href={`/tasks/${t.id}`} key={t.id}><div><strong>{t.title}</strong><small>{t.project.name}</small></div><span title={t.waitingSince ?? undefined}>{waitingLabel(t.waitingDays)}</span></Link>) : <p className="hint">Nothing is awaiting your approval.</p>)}
        <Link className="dashboard-panel-link" href="/approvals">Review approvals →</Link>
      </section>
      <section className="dashboard-panel" aria-label="Your projects"><header><h2>Your projects</h2><Link href="/projects">View all projects →</Link></header>
        <Status {...projects} retry={projects.reload} />
        {projects.data && (projects.data.items.length ? projects.data.items.map(p => <Link className="dashboard-row dashboard-project" href={`/projects/${p.id}`} key={p.id}><div><strong>{p.name}</strong><small>{p.total ? `${p.completed} of ${p.total} tasks done` : "No tasks yet"}{p.isVertical ? " · Vertical board" : ""}</small></div><div className="dashboard-progress"><span>Task completion</span><progress aria-label={`Task completion in ${p.name}`} max={100} value={p.percent} /><span>{p.percent}%</span></div></Link>) : <p className="hint">You have no active membership projects.</p>)}
      </section>
      <section className="dashboard-panel" aria-label="Recent activity"><header><h2>Recent activity</h2></header>
        <Status {...activity} retry={activity.reload} />
        {activity.data && (activity.data.items.length ? activity.data.items.map(r => <Link className="dashboard-row" href={`/projects/${r.project.id}/activity`} key={r.id}><div><strong>{r.who}</strong> {r.what}<small>{r.project.name}</small></div><span title={r.when}>{ago(r.ts)}</span></Link>) : <p className="hint">No recent activity you can view in your active projects.</p>)}
        {activity.data?.items[0] && <Link className="dashboard-panel-link" href={`/projects/${activity.data.items[0].project.id}/activity`}>View activity in {activity.data.items[0].project.name} →</Link>}
      </section>
    </div>
    {tasks.data && <p className="hint">Task summary as of {new Date(tasks.data.asOf).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })} IST. Project task completion counts non-deleted top-level tasks only.</p>}
    <Link href="/my-tasks">Open My tasks →</Link>
  </Page>;
}
