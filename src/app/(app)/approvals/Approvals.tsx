"use client";
import Link from "next/link";
import { useCallback, useState } from "react";
import { useGet } from "@/components/api";
import { LoadFailed, Skeleton } from "@/components/ui";
import { Page } from "../Shell";
import { waitingLabel, useDashboardRefresh, type TaskSummary } from "../Dashboard";
type Row = TaskSummary & { waitingDays: number | null };
type Queue = { asOf: string; total: number; items: Row[]; nextCursor: string | null };
export default function Approvals() {
  const [cursor, setCursor] = useState<string>();
  const [previous, setPrevious] = useState<Row[]>([]);
  const data = useGet<Queue>(`/api/dashboard?panel=approvals${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  const { reload } = data;
  const reset = useCallback(() => { setPrevious([]); setCursor(undefined); reload(); }, [reload]);
  useDashboardRefresh(reset);
  const rows = [...new Map([...previous, ...(data.data?.items ?? [])].map(r => [r.id, r])).values()];
  return <Page className="dashboard-view" title="Your approvals" sub={data.data ? `${data.data.total} task${data.data.total === 1 ? "" : "s"} awaiting your review` : " "} actions={<Link className="btn ghost" href="/">Back to Home</Link>}>
    {data.loading && <Skeleton />}
    {data.error && <LoadFailed onRetry={reset} />}
    <section className="dashboard-panel" aria-label="Tasks awaiting your approval">
      {rows.map(t => <Link className="dashboard-row" key={t.id} href={`/tasks/${t.id}`}><div><strong>{t.title}</strong><small>{t.project.name}</small></div><span>{waitingLabel(t.waitingDays)}</span></Link>)}
      {data.data && !rows.length && <p className="hint">Nothing is awaiting your approval.</p>}
      {data.data?.nextCursor && <button className="btn ghost" disabled={data.loading} onClick={() => { setPrevious(rows); setCursor(data.data!.nextCursor!); }}>Load more</button>}
    </section>
  </Page>;
}
