"use client";
import Link from "next/link";
import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { dueLabel, useGet } from "@/components/api";
import { LoadFailed, Skeleton } from "@/components/ui";
import { TaskModal } from "@/components/TaskModal";
import { Page, useMe } from "../Shell";
import type { WorkloadFilter } from "@/lib/workload";
import "./workload.css";
const labels: Record<WorkloadFilter, string> = { open: "Open", next7: "Next 7 days", overdue: "Overdue", awaiting: "Awaiting approval", blocked: "Blocked" };
type Data = { people: { id: string; name: string; counts: Record<WorkloadFilter, number> }[]; assignee: string | null; filter: WorkloadFilter; items: { id: string | null; title: string; dueDate: string | null; project: { id: string | null; name: string } }[] };
function Inner() {
  const query = useSearchParams();
  const router = useRouter();
  const me = useMe();
  const assignee = query.get("assignee");
  const filter = query.get("f") ?? "open";
  const task = query.get("task");
  const params = new URLSearchParams({ ...(assignee ? { assignee } : {}), f: filter });
  const { data, loading, error, reload } = useGet<Data>(`/api/workload?${params}`);
  const person = data?.people.find(p => p.id === assignee);
  return <Page title="Workload" sub="Open work in active projects you lead. Admins see the workspace.">
    {loading && !data && <Skeleton />}
    {error && <LoadFailed onRetry={reload} />}
    {data && <>
      <table className="tbl workload"><caption className="sr-only">Tasks by person, sorted by overdue then open</caption><thead><tr><th>Person</th>{Object.values(labels).map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{data.people.map(p => <tr key={p.id}><th scope="row">{p.name}</th>{(Object.keys(labels) as WorkloadFilter[]).map(f => <td key={f} data-label={labels[f]}><Link aria-label={`${p.name}: ${p.counts[f]} ${labels[f].toLowerCase()}`} href={`/workload?${new URLSearchParams({ assignee: p.id, f })}`}>{p.counts[f]}</Link></td>)}</tr>)}</tbody>
      </table>
      {!data.people.length && <div className="card empty">No active people yet.</div>}
      {person && <section aria-label="Matching tasks"><h2>{person.name} · {labels[data.filter]}</h2>
        {!data.items.length && <p>No matching tasks.</p>}
        <div className="list">{data.items.map((t, i) => <div className="item" key={t.id ?? `hidden-${i}`}>
          <div className="t">{t.id ? <Link href={`/workload?${params}&task=${encodeURIComponent(t.id)}`}>{t.title}</Link> : <span>{t.title}</span>}<small>{t.project.name}</small></div><span>{dueLabel(t.dueDate)}</span>
        </div>)}</div>
      </section>}
    </>}
    {task && <TaskModal id={task} me={me.id} onChanged={reload} onClose={() => router.push(`/workload?${params}`)} />}
  </Page>;
}
export default function WorkloadView() { return <Suspense fallback={<Skeleton />}><Inner /></Suspense>; }
