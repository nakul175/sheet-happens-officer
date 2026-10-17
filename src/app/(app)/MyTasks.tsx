"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { PRIORITY, dueLabel, isOverdue, useGet } from "@/components/api";
import { TaskModal } from "@/components/TaskModal";
import { Tick } from "@/components/TaskParts";
import { Page, useMe } from "./Shell";

type Item = {
  id: string; title: string; dueDate: string | null; blocked: boolean; priority: string; canClose: boolean; relation: "ASSIGNEE" | "COLLABORATOR";
  project: { id: string; name: string }; parent: { id: string; title: string } | null; awaitingApproval: boolean;
};
type Groups = { overdue: Item[]; next7: Item[]; later: Item[] };

function Inner() {
  const me = useMe();
  const { data, error, loading, reload } = useGet<Groups>("/api/my-tasks");
  const router = useRouter();
  const open = useSearchParams().get("task");
  const total = data ? data.overdue.length + data.next7.length + data.later.length : 0;
  const groups: [keyof Groups, string, boolean][] = [["overdue", "Overdue", true], ["next7", "Next 7 days", false], ["later", "Later", false]];
  return (
    <Page dock title="My tasks" sub={data ? `${total} open task${total === 1 ? "" : "s"} assigned to you or shared with you` : " "}>
      {loading && <div className="skel">Loading…</div>}
      {error && <div className="err" role="alert">{error}</div>}
      {data && total === 0 && (
        <div className="card empty"><b>Nothing on your plate.</b><br />Tasks assigned to you, or that you collaborate on, show up here.</div>
      )}
      {data && groups.map(([key, label, red]) => data[key].length > 0 && (
        <section key={key} aria-label={label}>
          <div className={`grp${red ? " red" : ""}`}>{label} · {data[key].length}</div>
          <div className="list">
            {data[key].map((t) => (
              <div key={t.id} className="item click" onClick={() => router.push(`/?task=${t.id}`, { scroll: false })}>
                <Tick id={t.id} title={t.title} done={false} allowed={t.relation === "ASSIGNEE" && t.canClose} onDone={reload} />
                <div className="t">
                  <b><a href={`/tasks/${t.id}`} style={{ color: "inherit", textDecoration: "none" }} onClick={(e) => { e.preventDefault(); }}>{t.title}</a></b>
                  <small>{t.parent ? `Subtask of ${t.parent.title} · ` : ""}{t.project.name}</small>
                </div>
                <div className="meta">
                  {t.relation === "COLLABORATOR" && <span className="chip grey">Collaborator</span>}
                  {t.awaitingApproval && <span className="chip gold">Awaiting approval</span>}
                  {t.blocked && <span className="chip red">Blocked</span>}
                  <span className={`pri-${t.priority}`}>{PRIORITY[t.priority]}</span>
                  <span className={isOverdue(t.dueDate) ? "over" : undefined}>{dueLabel(t.dueDate)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {open && <TaskModal id={open} me={me.id} onClose={() => router.push("/", { scroll: false })} onChanged={reload} />}
    </Page>
  );
}
export default function MyTasks() { return <Suspense><Inner /></Suspense>; }
